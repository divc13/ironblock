#!/usr/bin/env python3
"""Generate the small, self-contained SVG data-URL icons used in NEP-245 metadata.

The icons are on-chain metadata: keeping them as data URLs means the contract does
not depend on an external image host. Run this only when changing the artwork:

    python3 scripts/generate_icons.py
"""

from __future__ import annotations

import base64
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
SRC = ROOT / "src" / "icons.rs"

ICONS = {
    "iron_ore": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#3f3f46"/>
  <polygon points="8,45 22,21 38,29 32,51" fill="#71717a"/>
  <polygon points="30,29 44,13 59,26 55,45 38,49" fill="#a1a1aa"/>
  <polygon points="22,21 38,29 32,36 21,31" fill="#d4d4d8"/>
  <circle cx="45" cy="30" r="3" fill="#52525b"/>
  <circle cx="17" cy="39" r="2" fill="#52525b"/>
</svg>
""",
    "iron_ingot": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#292524"/>
  <polygon points="16,14 48,14 43,26 21,26" fill="#e2e8f0"/>
  <polygon points="12,27 52,27 47,41 17,41" fill="#94a3b8"/>
  <polygon points="18,42 46,42 42,53 22,53" fill="#64748b"/>
  <polygon points="16,14 48,14 46,18 18,18" fill="#f8fafc"/>
</svg>
""",
    "grain": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#422006"/>
  <path d="M32 56 L32 12" stroke="#facc15" stroke-width="3" stroke-linecap="round"/>
  <g fill="#fde047">
    <ellipse cx="24" cy="18" rx="7" ry="3.5" transform="rotate(35 24 18)"/>
    <ellipse cx="40" cy="22" rx="7" ry="3.5" transform="rotate(-35 40 22)"/>
    <ellipse cx="23" cy="28" rx="7" ry="3.5" transform="rotate(35 23 28)"/>
    <ellipse cx="41" cy="32" rx="7" ry="3.5" transform="rotate(-35 41 32)"/>
    <ellipse cx="24" cy="38" rx="7" ry="3.5" transform="rotate(35 24 38)"/>
    <ellipse cx="40" cy="42" rx="7" ry="3.5" transform="rotate(-35 40 42)"/>
    <ellipse cx="32" cy="10" rx="3.5" ry="6" fill="#fef08a"/>
  </g>
  <path d="M32 50 C22 48 16 42 12 34" stroke="#65a30d" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>
""",
    "flour": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#44403c"/>
  <path d="M22 16 L42 16 L46 25 L44 54 L20 54 L18 25 Z" fill="#fef3c7"/>
  <path d="M22 16 C24 10 28 8 32 8 C36 8 40 10 42 16" fill="#e7e5e4"/>
  <path d="M20 25 L44 25" stroke="#a8a29e" stroke-width="3"/>
  <circle cx="32" cy="39" r="8" fill="#fbbf24"/>
  <path d="M28 39 L36 39 M32 35 L32 43" stroke="#78350f" stroke-width="2" stroke-linecap="round"/>
</svg>
""",
    "timber": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#1c1917"/>
  <rect x="10" y="15" width="44" height="15" rx="7" fill="#92400e"/>
  <rect x="10" y="34" width="44" height="15" rx="7" fill="#78350f"/>
  <ellipse cx="14" cy="22.5" rx="6" ry="7.5" fill="#d97706"/>
  <ellipse cx="14" cy="41.5" rx="6" ry="7.5" fill="#b45309"/>
  <ellipse cx="14" cy="22.5" rx="3" ry="4" fill="#92400e"/>
  <ellipse cx="14" cy="41.5" rx="3" ry="4" fill="#78350f"/>
  <path d="M24 18 L50 18 M24 37 L50 37" stroke="#b45309" stroke-width="2" stroke-linecap="round"/>
</svg>
""",
    "plank": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#292524"/>
  <g fill="#d97706" stroke="#92400e" stroke-width="1.5">
    <rect x="9" y="13" width="46" height="11" rx="2" transform="rotate(-3 32 18)"/>
    <rect x="9" y="27" width="46" height="11" rx="2" transform="rotate(2 32 32)"/>
    <rect x="9" y="41" width="46" height="11" rx="2" transform="rotate(-2 32 46)"/>
  </g>
  <g stroke="#b45309" stroke-width="1.5" stroke-linecap="round">
    <path d="M16 18 L26 18 M36 18 L48 18"/>
    <path d="M16 32 L28 32 M38 32 L48 32"/>
    <path d="M16 47 L26 47 M36 47 L48 47"/>
  </g>
</svg>
""",
    "wool": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#292524"/>
  <circle cx="31" cy="33" r="19" fill="#fafaf9"/>
  <path d="M16 27 C26 20 43 22 48 32 M15 37 C25 30 42 31 49 41 M20 47 C30 40 42 40 46 46" stroke="#d6d3d1" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <path d="M44 44 C56 42 56 24 48 20" stroke="#e7e5e4" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M48 20 L53 18 M48 20 L51 25" stroke="#a8a29e" stroke-width="2" stroke-linecap="round"/>
  <circle cx="23" cy="29" r="2" fill="#d6d3d1"/>
</svg>
""",
    "cloth": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#172554"/>
  <path d="M13 20 L37 14 L51 25 L27 32 Z" fill="#60a5fa"/>
  <path d="M27 32 L51 25 L49 45 L25 52 Z" fill="#3b82f6"/>
  <path d="M13 20 L27 32 L25 52 L11 39 Z" fill="#2563eb"/>
  <path d="M17 23 L24 30 M18 31 L20 34 M30 35 L45 30 M29 41 L44 37 M29 46 L41 43" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/>
</svg>
""",
    "pickaxe": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#292524"/>
  <path d="M18 54 L44 22" stroke="#b45309" stroke-width="6" stroke-linecap="round"/>
  <path d="M14 18 C27 8 47 10 56 20 C49 19 44 23 40 28 C36 23 27 20 20 24 C17 25 14 22 14 18 Z" fill="#cbd5e1"/>
  <path d="M20 24 C27 20 36 23 40 28" stroke="#94a3b8" stroke-width="2" fill="none"/>
  <path d="M18 54 L21 51" stroke="#78350f" stroke-width="6" stroke-linecap="round"/>
</svg>
""",
    "hoe": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#292524"/>
  <path d="M18 55 L45 19" stroke="#b45309" stroke-width="6" stroke-linecap="round"/>
  <path d="M39 16 L54 16 C56 16 57 18 56 20 L50 29 L43 24 Z" fill="#cbd5e1"/>
  <path d="M43 24 L50 29" stroke="#94a3b8" stroke-width="2"/>
  <path d="M18 54 L21 51" stroke="#78350f" stroke-width="6" stroke-linecap="round"/>
</svg>
""",
    "axe": """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#292524"/>
  <path d="M18 55 L43 20" stroke="#b45309" stroke-width="6" stroke-linecap="round"/>
  <path d="M38 15 C45 9 54 11 58 18 L50 37 L42 29 C45 24 44 19 38 15 Z" fill="#cbd5e1"/>
  <path d="M42 29 L50 37" stroke="#94a3b8" stroke-width="2"/>
  <path d="M18 54 L21 51" stroke="#78350f" stroke-width="6" stroke-linecap="round"/>
</svg>
""",
}


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    constants: list[str] = []
    for name, svg in ICONS.items():
        # Collapse the pretty-printed SVG to a compact, single-line document.
        compact = " ".join(line.strip() for line in svg.strip().splitlines())
        encoded = base64.b64encode(compact.encode("utf-8")).decode("ascii")
        (ICON_DIR / f"{name}.svg").write_text(compact + "\n", encoding="utf-8")
        constants.append(
            f'pub const {name.upper()}_ICON: &str = "data:image/svg+xml;base64,{encoded}";'
        )

    SRC.write_text(
        "// Generated by scripts/generate_icons.py. Do not edit by hand.\n"
        "// Each icon is a self-contained data URL so metadata has no external dependency.\n\n"
        + "\n".join(constants)
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
