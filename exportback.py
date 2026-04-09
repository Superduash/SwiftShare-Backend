"""Export important Backend code files into one compact text file.

Usage:
  python exportback.py
  python exportback.py -o backendcode.txt
  python exportback.py --stdout
  python exportback.py --max-bytes 600000
"""

from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path
from typing import Iterable


IMPORTANT_TOP_DIRS = {
    "config",
    "middleware",
    "models",
    "routes",
    "scripts",
    "services",
    "utils",
}

IMPORTANT_ROOT_FILES = {
    "server.js",
    "instrument.js",
    "package.json",
    "README.md",
    "render.yaml",
    ".env.example",
}

CODE_EXTENSIONS = {
    ".js",
    ".cjs",
    ".mjs",
    ".json",
    ".md",
    ".yml",
    ".yaml",
}

EXCLUDED_DIR_NAMES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".vscode",
    ".idea",
    "dist",
    "build",
    "coverage",
}

EXCLUDED_FILE_NAMES = {
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "backendcode.txt",
}

EXCLUDED_FILE_SUFFIXES = {
    ".log",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
}


def iter_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file():
            continue

        rel = path.relative_to(root)

        if any(part in EXCLUDED_DIR_NAMES or part.startswith(".tmp") for part in rel.parts):
            continue

        if rel.name in EXCLUDED_FILE_NAMES:
            continue

        if path.suffix.lower() in EXCLUDED_FILE_SUFFIXES:
            continue

        yield path


def is_important(root: Path, path: Path) -> bool:
    rel = path.relative_to(root)
    rel_posix = str(rel).replace("\\", "/")

    if rel_posix in IMPORTANT_ROOT_FILES:
        return True

    if len(rel.parts) >= 2 and rel.parts[0] in IMPORTANT_TOP_DIRS:
        return path.suffix.lower() in CODE_EXTENSIONS

    return False


def read_text_safe(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def build_export(root: Path, max_bytes: int) -> tuple[str, int, int, int]:
    files = [p for p in iter_files(root) if is_important(root, p)]
    files.sort(key=lambda p: str(p.relative_to(root)).replace("\\", "/"))

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    chunks = [
        "# Backend export\n",
        f"Generated: {now}\n",
        f"Root: {root}\n",
        "\n",
    ]

    included = 0
    skipped_too_large = 0
    total_bytes = 0

    for path in files:
        rel = str(path.relative_to(root)).replace("\\", "/")
        size = path.stat().st_size

        if size > max_bytes:
            skipped_too_large += 1
            continue

        text = read_text_safe(path)
        total_bytes += size
        included += 1

        chunks.append(f"===== FILE: {rel} ({size} bytes) =====\n")
        chunks.append(text)
        if not text.endswith("\n"):
            chunks.append("\n")
        chunks.append("\n")

    summary = (
        "===== SUMMARY =====\n"
        f"Included files: {included}\n"
        f"Skipped (too large): {skipped_too_large}\n"
        f"Total source bytes included: {total_bytes}\n"
    )
    chunks.append(summary)

    return "".join(chunks), included, skipped_too_large, total_bytes


def main() -> int:
    parser = argparse.ArgumentParser(description="Export important backend code files into one compact text file.")
    parser.add_argument(
        "--root",
        default=str(Path(__file__).resolve().parent),
        help="Backend root folder to export (default: folder containing this script).",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="backendcode.txt",
        help="Output file path (default: backendcode.txt in root).",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=500_000,
        help="Skip any single file larger than this many bytes (default: 500000).",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print export to stdout instead of writing output file.",
    )

    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Invalid root directory: {root}")

    content, included, skipped, total = build_export(root, args.max_bytes)

    if args.stdout:
        print(content)
        return 0

    output = Path(args.output)
    if not output.is_absolute():
        output = root / output

    output.write_text(content, encoding="utf-8")
    print(f"Export written to: {output}")
    print(f"Included files: {included}")
    print(f"Skipped (too large): {skipped}")
    print(f"Total source bytes included: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
