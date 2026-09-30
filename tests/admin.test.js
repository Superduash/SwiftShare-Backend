'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Set required environment variables for test execution
process.env.NODE_ENV = 'test';
process.env.ADMIN_ENABLED = 'true';
process.env.ADMIN_USERNAME = 'Superduash';
process.env.ADMIN_PASSWORD_HASH = '$2b$12$eS/whaMJcypEep5pHS7lUeU5Xnql8QsJUGqMGocyFvtWMO5d6hWai';
process.env.ADMIN_JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ANALYTICS_HASH_SALT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.TOKEN_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { app } = require('../server');
const AdminSession = require('../models/AdminSession');
const AdminAudit = require('../models/AdminAudit');
const PageView = require('../models/PageView');
const Transfer = require('../models/Transfer');
const { signAdminToken, verifyAdminToken, maskIp, parseUserAgent } = require('../utils/adminAuth');

describe('Admin Authentication & Security', () => {
  let validToken = '';

  beforeAll(async () => {
    const nowMs = Date.now();
    const jti = crypto.randomUUID();
    validToken = signAdminToken({
      sub: 'admin',
      username: 'Superduash',
      jti,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor((nowMs + 3600000) / 1000),
    });

    // Mock AdminSession.findOne to resolve immediately during tests
    jest.spyOn(AdminSession, 'findOne').mockReturnValue({
      lean: () => Promise.resolve({
        jti,
        username: 'Superduash',
        createdAt: new Date(),
        expiresAt: new Date(nowMs + 3600000),
      }),
    });

    // Mock PageView.create to resolve immediately
    jest.spyOn(PageView, 'create').mockResolvedValue({});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
  });

  describe('Token Signing & Verification', () => {
    it('signs and verifies valid tokens correctly', () => {
      const jti = crypto.randomUUID();
      const token = signAdminToken({
        sub: 'admin',
        username: 'Superduash',
        jti,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const payload = verifyAdminToken(token);
      expect(payload).toBeDefined();
      expect(payload.username).toBe('Superduash');
      expect(payload.jti).toBe(jti);
    });

    it('rejects tampered tokens', () => {
      const parts = validToken.split('.');
      const tampered = `${parts[0]}.invalidSignature`;
      expect(verifyAdminToken(tampered)).toBeNull();
    });

    it('rejects expired tokens', () => {
      const expiredToken = signAdminToken({
        sub: 'admin',
        username: 'Superduash',
        jti: crypto.randomUUID(),
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      expect(verifyAdminToken(expiredToken)).toBeNull();
    });
  });

  describe('IP Masking & User-Agent Parsing', () => {
    it('masks IPv4 and IPv6 addresses correctly', () => {
      expect(maskIp('192.168.1.150')).toBe('192.168.x.x');
      expect(maskIp('::ffff:203.0.113.195')).toBe('203.0.x.x');
      expect(maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8::x');
      expect(maskIp('')).toBe('');
    });

    it('identifies crawlers and search bots properly', () => {
      const googlebot = parseUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
      expect(googlebot.isBot).toBe(true);
      expect(googlebot.botName).toBe('Googlebot');

      const mobileChrome = parseUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
      expect(mobileChrome.isBot).toBe(false);
      expect(mobileChrome.device).toBe('mobile');
      expect(mobileChrome.browser).toBe('Chrome');
      expect(mobileChrome.os).toBe('Android');
    });
  });

  describe('Admin Endpoints Access Control', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/admin/overview');
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.headers['x-robots-tag']).toContain('noindex');
    });

    it('returns 401 when token is invalid or forged', async () => {
      const res = await request(app)
        .get('/api/admin/overview')
        .set('Authorization', 'Bearer forged.invalid.token');
      expect(res.status).toBe(401);
    });

    it('allows access with valid session token', async () => {
      const res = await request(app)
        .get('/api/admin/session')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.username).toBe('Superduash');
    });

    it('disables admin routes when ADMIN_ENABLED is false', async () => {
      const original = process.env.ADMIN_ENABLED;
      process.env.ADMIN_ENABLED = 'false';

      const res = await request(app).get('/api/admin/overview');
      expect(res.status).toBe(404);

      process.env.ADMIN_ENABLED = original;
    });
  });

  describe('PageView Ingestion & Route Normalization', () => {
    it('accepts valid pageview beacons with 204 No Content', async () => {
      const res = await request(app)
        .post('/api/analytics/pv')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({
          route: '/g/ABC123XYZ',
          ref: 'https://google.com/search?q=swiftshare',
          country: 'IN',
          vid: crypto.randomUUID(),
          sid: crypto.randomUUID(),
        }));

      expect(res.status).toBe(204);
    });
  });
});
