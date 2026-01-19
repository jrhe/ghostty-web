/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink } from './types';
import { CellFlags } from './types';

// ============================================================================
// Box-Drawing Character Rendering
// ============================================================================

/**
 * Check if a codepoint is a box-drawing character (U+2500-257F)
 */
function isBoxDrawingChar(codepoint: number): boolean {
  return codepoint >= 0x2500 && codepoint <= 0x257f;
}

/**
 * Line style for box-drawing characters
 */
type LineStyle = 'none' | 'light' | 'heavy' | 'double';

/**
 * Specifies which lines extend from the center of a box-drawing character
 */
interface BoxLines {
  up: LineStyle;
  right: LineStyle;
  down: LineStyle;
  left: LineStyle;
}

/**
 * Mapping from box-drawing codepoints to their line configurations.
 * Based on Ghostty's box.zig implementation.
 *
 * Phase 1: Light lines (most common)
 * Phase 2: Heavy lines
 * Phase 3: Double lines
 * Phase 4: Mixed and special (dashed, rounded, etc.)
 */
const BOX_DRAWING_MAP: Record<number, BoxLines> = {
  // Phase 1: Light lines
  0x2500: { up: 'none', right: 'light', down: 'none', left: 'light' },    // ─ horizontal
  0x2502: { up: 'light', right: 'none', down: 'light', left: 'none' },    // │ vertical
  0x250c: { up: 'none', right: 'light', down: 'light', left: 'none' },    // ┌ down and right
  0x2510: { up: 'none', right: 'none', down: 'light', left: 'light' },    // ┐ down and left
  0x2514: { up: 'light', right: 'light', down: 'none', left: 'none' },    // └ up and right
  0x2518: { up: 'light', right: 'none', down: 'none', left: 'light' },    // ┘ up and left
  0x251c: { up: 'light', right: 'light', down: 'light', left: 'none' },   // ├ vertical and right
  0x2524: { up: 'light', right: 'none', down: 'light', left: 'light' },   // ┤ vertical and left
  0x252c: { up: 'none', right: 'light', down: 'light', left: 'light' },   // ┬ down and horizontal
  0x2534: { up: 'light', right: 'light', down: 'none', left: 'light' },   // ┴ up and horizontal
  0x253c: { up: 'light', right: 'light', down: 'light', left: 'light' },  // ┼ vertical and horizontal

  // Phase 2: Heavy lines
  0x2501: { up: 'none', right: 'heavy', down: 'none', left: 'heavy' },    // ━ heavy horizontal
  0x2503: { up: 'heavy', right: 'none', down: 'heavy', left: 'none' },    // ┃ heavy vertical
  0x250f: { up: 'none', right: 'heavy', down: 'heavy', left: 'none' },    // ┏ heavy down and right
  0x2513: { up: 'none', right: 'none', down: 'heavy', left: 'heavy' },    // ┓ heavy down and left
  0x2517: { up: 'heavy', right: 'heavy', down: 'none', left: 'none' },    // ┗ heavy up and right
  0x251b: { up: 'heavy', right: 'none', down: 'none', left: 'heavy' },    // ┛ heavy up and left
  0x2523: { up: 'heavy', right: 'heavy', down: 'heavy', left: 'none' },   // ┣ heavy vertical and right
  0x252b: { up: 'heavy', right: 'none', down: 'heavy', left: 'heavy' },   // ┫ heavy vertical and left
  0x2533: { up: 'none', right: 'heavy', down: 'heavy', left: 'heavy' },   // ┳ heavy down and horizontal
  0x253b: { up: 'heavy', right: 'heavy', down: 'none', left: 'heavy' },   // ┻ heavy up and horizontal
  0x254b: { up: 'heavy', right: 'heavy', down: 'heavy', left: 'heavy' },  // ╋ heavy vertical and horizontal

  // Phase 3: Double lines
  0x2550: { up: 'none', right: 'double', down: 'none', left: 'double' },  // ═ double horizontal
  0x2551: { up: 'double', right: 'none', down: 'double', left: 'none' },  // ║ double vertical
  0x2554: { up: 'none', right: 'double', down: 'double', left: 'none' },  // ╔ double down and right
  0x2557: { up: 'none', right: 'none', down: 'double', left: 'double' },  // ╗ double down and left
  0x255a: { up: 'double', right: 'double', down: 'none', left: 'none' },  // ╚ double up and right
  0x255d: { up: 'double', right: 'none', down: 'none', left: 'double' },  // ╝ double up and left
  0x2560: { up: 'double', right: 'double', down: 'double', left: 'none' },// ╠ double vertical and right
  0x2563: { up: 'double', right: 'none', down: 'double', left: 'double' },// ╣ double vertical and left
  0x2566: { up: 'none', right: 'double', down: 'double', left: 'double' },// ╦ double down and horizontal
  0x2569: { up: 'double', right: 'double', down: 'none', left: 'double' },// ╩ double up and horizontal
  0x256c: { up: 'double', right: 'double', down: 'double', left: 'double' },// ╬ double vertical and horizontal

  // Mixed light/heavy
  0x250d: { up: 'none', right: 'heavy', down: 'light', left: 'none' },    // ┍ down light and right heavy
  0x250e: { up: 'none', right: 'light', down: 'heavy', left: 'none' },    // ┎ down heavy and right light
  0x2511: { up: 'none', right: 'none', down: 'light', left: 'heavy' },    // ┑ down light and left heavy
  0x2512: { up: 'none', right: 'none', down: 'heavy', left: 'light' },    // ┒ down heavy and left light
  0x2515: { up: 'light', right: 'heavy', down: 'none', left: 'none' },    // ┕ up light and right heavy
  0x2516: { up: 'heavy', right: 'light', down: 'none', left: 'none' },    // ┖ up heavy and right light
  0x2519: { up: 'light', right: 'none', down: 'none', left: 'heavy' },    // ┙ up light and left heavy
  0x251a: { up: 'heavy', right: 'none', down: 'none', left: 'light' },    // ┚ up heavy and left light

  // T-junctions with mixed weights
  0x251d: { up: 'light', right: 'heavy', down: 'light', left: 'none' },   // ┝ vertical light and right heavy
  0x251e: { up: 'heavy', right: 'light', down: 'light', left: 'none' },   // ┞ up heavy and right down light
  0x251f: { up: 'light', right: 'light', down: 'heavy', left: 'none' },   // ┟ down heavy and right up light
  0x2520: { up: 'heavy', right: 'light', down: 'heavy', left: 'none' },   // ┠ vertical heavy and right light
  0x2521: { up: 'heavy', right: 'heavy', down: 'light', left: 'none' },   // ┡ down light and right up heavy
  0x2522: { up: 'light', right: 'heavy', down: 'heavy', left: 'none' },   // ┢ up light and right down heavy
  0x2525: { up: 'light', right: 'none', down: 'light', left: 'heavy' },   // ┥ vertical light and left heavy
  0x2526: { up: 'heavy', right: 'none', down: 'light', left: 'light' },   // ┦ up heavy and left down light
  0x2527: { up: 'light', right: 'none', down: 'heavy', left: 'light' },   // ┧ down heavy and left up light
  0x2528: { up: 'heavy', right: 'none', down: 'heavy', left: 'light' },   // ┨ vertical heavy and left light
  0x2529: { up: 'heavy', right: 'none', down: 'light', left: 'heavy' },   // ┩ down light and left up heavy
  0x252a: { up: 'light', right: 'none', down: 'heavy', left: 'heavy' },   // ┪ up light and left down heavy

  0x252d: { up: 'none', right: 'light', down: 'light', left: 'heavy' },   // ┭ left heavy and right down light
  0x252e: { up: 'none', right: 'heavy', down: 'light', left: 'light' },   // ┮ right heavy and left down light
  0x252f: { up: 'none', right: 'heavy', down: 'light', left: 'heavy' },   // ┯ down light and horizontal heavy
  0x2530: { up: 'none', right: 'light', down: 'heavy', left: 'light' },   // ┰ down heavy and horizontal light
  0x2531: { up: 'none', right: 'light', down: 'heavy', left: 'heavy' },   // ┱ right light and left down heavy
  0x2532: { up: 'none', right: 'heavy', down: 'heavy', left: 'light' },   // ┲ left light and right down heavy

  0x2535: { up: 'light', right: 'light', down: 'none', left: 'heavy' },   // ┵ left heavy and right up light
  0x2536: { up: 'light', right: 'heavy', down: 'none', left: 'light' },   // ┶ right heavy and left up light
  0x2537: { up: 'light', right: 'heavy', down: 'none', left: 'heavy' },   // ┷ up light and horizontal heavy
  0x2538: { up: 'heavy', right: 'light', down: 'none', left: 'light' },   // ┸ up heavy and horizontal light
  0x2539: { up: 'heavy', right: 'light', down: 'none', left: 'heavy' },   // ┹ right light and left up heavy
  0x253a: { up: 'heavy', right: 'heavy', down: 'none', left: 'light' },   // ┺ left light and right up heavy

  // Cross junctions with mixed weights
  0x253d: { up: 'light', right: 'light', down: 'light', left: 'heavy' },  // ┽ left heavy and right vertical light
  0x253e: { up: 'light', right: 'heavy', down: 'light', left: 'light' },  // ┾ right heavy and left vertical light
  0x253f: { up: 'light', right: 'heavy', down: 'light', left: 'heavy' },  // ┿ vertical light and horizontal heavy
  0x2540: { up: 'heavy', right: 'light', down: 'light', left: 'light' },  // ╀ up heavy and down horizontal light
  0x2541: { up: 'light', right: 'light', down: 'heavy', left: 'light' },  // ╁ down heavy and up horizontal light
  0x2542: { up: 'heavy', right: 'light', down: 'heavy', left: 'light' },  // ╂ vertical heavy and horizontal light
  0x2543: { up: 'heavy', right: 'light', down: 'light', left: 'heavy' },  // ╃ left up heavy and right down light
  0x2544: { up: 'heavy', right: 'heavy', down: 'light', left: 'light' },  // ╄ right up heavy and left down light
  0x2545: { up: 'light', right: 'light', down: 'heavy', left: 'heavy' },  // ╅ left down heavy and right up light
  0x2546: { up: 'light', right: 'heavy', down: 'heavy', left: 'light' },  // ╆ right down heavy and left up light
  0x2547: { up: 'heavy', right: 'heavy', down: 'light', left: 'heavy' },  // ╇ down light and up horizontal heavy
  0x2548: { up: 'light', right: 'heavy', down: 'heavy', left: 'heavy' },  // ╈ up light and down horizontal heavy
  0x2549: { up: 'heavy', right: 'light', down: 'heavy', left: 'heavy' },  // ╉ right light and left vertical heavy
  0x254a: { up: 'heavy', right: 'heavy', down: 'heavy', left: 'light' },  // ╊ left light and right vertical heavy

  // Mixed double/light
  0x2552: { up: 'none', right: 'double', down: 'light', left: 'none' },   // ╒ down light and right double
  0x2553: { up: 'none', right: 'light', down: 'double', left: 'none' },   // ╓ down double and right light
  0x2555: { up: 'none', right: 'none', down: 'light', left: 'double' },   // ╕ down light and left double
  0x2556: { up: 'none', right: 'none', down: 'double', left: 'light' },   // ╖ down double and left light
  0x2558: { up: 'light', right: 'double', down: 'none', left: 'none' },   // ╘ up light and right double
  0x2559: { up: 'double', right: 'light', down: 'none', left: 'none' },   // ╙ up double and right light
  0x255b: { up: 'light', right: 'none', down: 'none', left: 'double' },   // ╛ up light and left double
  0x255c: { up: 'double', right: 'none', down: 'none', left: 'light' },   // ╜ up double and left light
  0x255e: { up: 'light', right: 'double', down: 'light', left: 'none' },  // ╞ vertical light and right double
  0x255f: { up: 'double', right: 'light', down: 'double', left: 'none' }, // ╟ vertical double and right light
  0x2561: { up: 'light', right: 'none', down: 'light', left: 'double' },  // ╡ vertical light and left double
  0x2562: { up: 'double', right: 'none', down: 'double', left: 'light' }, // ╢ vertical double and left light
  0x2564: { up: 'none', right: 'double', down: 'light', left: 'double' }, // ╤ down light and horizontal double
  0x2565: { up: 'none', right: 'light', down: 'double', left: 'light' },  // ╥ down double and horizontal light
  0x2567: { up: 'light', right: 'double', down: 'none', left: 'double' }, // ╧ up light and horizontal double
  0x2568: { up: 'double', right: 'light', down: 'none', left: 'light' },  // ╨ up double and horizontal light
  0x256a: { up: 'light', right: 'double', down: 'light', left: 'double' },// ╪ vertical light and horizontal double
  0x256b: { up: 'double', right: 'light', down: 'double', left: 'light' },// ╫ vertical double and horizontal light

  // Dashed lines (Phase 4)
  0x2504: { up: 'none', right: 'light', down: 'none', left: 'light' },    // ┄ triple dash horizontal (treat as light)
  0x2505: { up: 'none', right: 'heavy', down: 'none', left: 'heavy' },    // ┅ triple dash horizontal heavy
  0x2506: { up: 'light', right: 'none', down: 'light', left: 'none' },    // ┆ triple dash vertical
  0x2507: { up: 'heavy', right: 'none', down: 'heavy', left: 'none' },    // ┇ triple dash vertical heavy
  0x2508: { up: 'none', right: 'light', down: 'none', left: 'light' },    // ┈ quadruple dash horizontal
  0x2509: { up: 'none', right: 'heavy', down: 'none', left: 'heavy' },    // ┉ quadruple dash horizontal heavy
  0x250a: { up: 'light', right: 'none', down: 'light', left: 'none' },    // ┊ quadruple dash vertical
  0x250b: { up: 'heavy', right: 'none', down: 'heavy', left: 'none' },    // ┋ quadruple dash vertical heavy
  0x254c: { up: 'none', right: 'light', down: 'none', left: 'light' },    // ╌ double dash horizontal
  0x254d: { up: 'none', right: 'heavy', down: 'none', left: 'heavy' },    // ╍ double dash horizontal heavy
  0x254e: { up: 'light', right: 'none', down: 'light', left: 'none' },    // ╎ double dash vertical
  0x254f: { up: 'heavy', right: 'none', down: 'heavy', left: 'none' },    // ╏ double dash vertical heavy

  // Rounded corners (Phase 4) - treat as light lines
  0x256d: { up: 'none', right: 'light', down: 'light', left: 'none' },    // ╭ arc down and right
  0x256e: { up: 'none', right: 'none', down: 'light', left: 'light' },    // ╮ arc down and left
  0x256f: { up: 'light', right: 'none', down: 'none', left: 'light' },    // ╯ arc up and left
  0x2570: { up: 'light', right: 'light', down: 'none', left: 'none' },    // ╰ arc up and right

  // Half lines
  0x2574: { up: 'none', right: 'none', down: 'none', left: 'light' },     // ╴ left light
  0x2575: { up: 'light', right: 'none', down: 'none', left: 'none' },     // ╵ up light
  0x2576: { up: 'none', right: 'light', down: 'none', left: 'none' },     // ╶ right light
  0x2577: { up: 'none', right: 'none', down: 'light', left: 'none' },     // ╷ down light
  0x2578: { up: 'none', right: 'none', down: 'none', left: 'heavy' },     // ╸ left heavy
  0x2579: { up: 'heavy', right: 'none', down: 'none', left: 'none' },     // ╹ up heavy
  0x257a: { up: 'none', right: 'heavy', down: 'none', left: 'none' },     // ╺ right heavy
  0x257b: { up: 'none', right: 'none', down: 'heavy', left: 'none' },     // ╻ down heavy
  0x257c: { up: 'none', right: 'heavy', down: 'none', left: 'light' },    // ╼ left light and right heavy
  0x257d: { up: 'light', right: 'none', down: 'heavy', left: 'none' },    // ╽ up light and down heavy
  0x257e: { up: 'none', right: 'light', down: 'none', left: 'heavy' },    // ╾ left heavy and right light
  0x257f: { up: 'heavy', right: 'none', down: 'light', left: 'none' },    // ╿ up heavy and down light
};

/**
 * Get box line configuration for a codepoint
 */
function getBoxLines(codepoint: number): BoxLines | null {
  return BOX_DRAWING_MAP[codepoint] ?? null;
}

// ============================================================================
// Block Element Character Rendering (U+2580-259F)
// ============================================================================

/**
 * Check if a codepoint is a block element character (U+2580-259F)
 */
function isBlockElement(codepoint: number): boolean {
  return codepoint >= 0x2580 && codepoint <= 0x259f;
}

/**
 * Block element types for rendering
 */
type BlockType =
  | { type: 'full' }
  | { type: 'upper'; eighths: number }      // Upper N/8 of cell
  | { type: 'lower'; eighths: number }      // Lower N/8 of cell
  | { type: 'left'; eighths: number }       // Left N/8 of cell
  | { type: 'right'; eighths: number }      // Right N/8 of cell
  | { type: 'quadrants'; tl: boolean; tr: boolean; bl: boolean; br: boolean }
  | { type: 'shade'; density: number };     // 0.25, 0.5, or 0.75

/**
 * Get block element configuration for a codepoint
 */
function getBlockType(codepoint: number): BlockType | null {
  switch (codepoint) {
    // Upper blocks (2580-2587): upper half to upper 7/8
    case 0x2580: return { type: 'upper', eighths: 4 };  // ▀ upper half
    case 0x2581: return { type: 'lower', eighths: 1 };  // ▁ lower 1/8
    case 0x2582: return { type: 'lower', eighths: 2 };  // ▂ lower 1/4
    case 0x2583: return { type: 'lower', eighths: 3 };  // ▃ lower 3/8
    case 0x2584: return { type: 'lower', eighths: 4 };  // ▄ lower half
    case 0x2585: return { type: 'lower', eighths: 5 };  // ▅ lower 5/8
    case 0x2586: return { type: 'lower', eighths: 6 };  // ▆ lower 3/4
    case 0x2587: return { type: 'lower', eighths: 7 };  // ▇ lower 7/8

    // Full block
    case 0x2588: return { type: 'full' };               // █ full block

    // Left blocks (2589-258F): left 7/8 to left 1/8
    case 0x2589: return { type: 'left', eighths: 7 };   // ▉ left 7/8
    case 0x258a: return { type: 'left', eighths: 6 };   // ▊ left 3/4
    case 0x258b: return { type: 'left', eighths: 5 };   // ▋ left 5/8
    case 0x258c: return { type: 'left', eighths: 4 };   // ▌ left half
    case 0x258d: return { type: 'left', eighths: 3 };   // ▍ left 3/8
    case 0x258e: return { type: 'left', eighths: 2 };   // ▎ left 1/4
    case 0x258f: return { type: 'left', eighths: 1 };   // ▏ left 1/8

    // Right half
    case 0x2590: return { type: 'right', eighths: 4 };  // ▐ right half

    // Shades
    case 0x2591: return { type: 'shade', density: 0.25 }; // ░ light shade
    case 0x2592: return { type: 'shade', density: 0.50 }; // ▒ medium shade
    case 0x2593: return { type: 'shade', density: 0.75 }; // ▓ dark shade

    // Upper half inverse (2594) and right 1/8 (2595)
    case 0x2594: return { type: 'upper', eighths: 1 };  // ▔ upper 1/8
    case 0x2595: return { type: 'right', eighths: 1 };  // ▕ right 1/8

    // Quadrants (2596-259F)
    case 0x2596: return { type: 'quadrants', tl: false, tr: false, bl: true, br: false };  // ▖
    case 0x2597: return { type: 'quadrants', tl: false, tr: false, bl: false, br: true };  // ▗
    case 0x2598: return { type: 'quadrants', tl: true, tr: false, bl: false, br: false };  // ▘
    case 0x2599: return { type: 'quadrants', tl: true, tr: false, bl: true, br: true };    // ▙
    case 0x259a: return { type: 'quadrants', tl: true, tr: false, bl: false, br: true };   // ▚
    case 0x259b: return { type: 'quadrants', tl: true, tr: true, bl: true, br: false };    // ▛
    case 0x259c: return { type: 'quadrants', tl: true, tr: true, bl: false, br: true };    // ▜
    case 0x259d: return { type: 'quadrants', tl: false, tr: true, bl: false, br: false };  // ▝
    case 0x259e: return { type: 'quadrants', tl: false, tr: true, bl: true, br: false };   // ▞
    case 0x259f: return { type: 'quadrants', tl: false, tr: true, bl: true, br: true };    // ▟

    default: return null;
  }
}

// ============================================================================
// Braille Pattern Rendering (U+2800-28FF)
// ============================================================================

/**
 * Check if a codepoint is a Braille pattern (U+2800-28FF)
 *
 * Braille patterns form a 2×4 dot matrix where each dot can be on or off.
 * The codepoint encodes which dots are present as a bitmask:
 *
 *   Dot positions:     Bit values:
 *   [1] [4]            0x01  0x08
 *   [2] [5]            0x02  0x10
 *   [3] [6]            0x04  0x20
 *   [7] [8]            0x40  0x80
 *
 * Codepoint = 0x2800 + (sum of bit values for present dots)
 */
function isBraillePattern(codepoint: number): boolean {
  return codepoint >= 0x2800 && codepoint <= 0x28ff;
}

/**
 * Get which dots are present in a Braille pattern.
 * Returns an array of 8 booleans for dots 1-8.
 */
function getBrailleDots(codepoint: number): boolean[] {
  const pattern = codepoint - 0x2800;
  return [
    (pattern & 0x01) !== 0,  // Dot 1 (top-left)
    (pattern & 0x02) !== 0,  // Dot 2 (middle-upper-left)
    (pattern & 0x04) !== 0,  // Dot 3 (middle-lower-left)
    (pattern & 0x08) !== 0,  // Dot 4 (top-right)
    (pattern & 0x10) !== 0,  // Dot 5 (middle-upper-right)
    (pattern & 0x20) !== 0,  // Dot 6 (middle-lower-right)
    (pattern & 0x40) !== 0,  // Dot 7 (bottom-left)
    (pattern & 0x80) !== 0,  // Dot 8 (bottom-right)
  ];
}

// ============================================================================
// Sextant Character Rendering (U+1FB00-1FB3B)
// ============================================================================

/**
 * Check if a codepoint is a sextant character (U+1FB00-1FB3B)
 *
 * Sextants are 2×3 grids (6 segments) - higher resolution than quadrants.
 * Each segment can be filled or empty.
 *
 *   Segment positions:
 *   [0] [1]
 *   [2] [3]
 *   [4] [5]
 *
 * The codepoint encodes which segments are filled.
 * U+1FB00 starts at segment pattern 1 (only segment 0 filled).
 */
function isSextant(codepoint: number): boolean {
  return codepoint >= 0x1fb00 && codepoint <= 0x1fb3b;
}

/**
 * Get which segments are filled in a sextant character.
 * Returns an array of 6 booleans for segments 0-5.
 *
 * The encoding maps codepoint to a 6-bit pattern:
 * - U+1FB00 = pattern 1 (segment 0 only)
 * - Pattern 0 (empty) doesn't exist (use space)
 * - Pattern 63 (all filled) doesn't exist (use full block █)
 */
function getSextantSegments(codepoint: number): boolean[] {
  // The sextant block starts at U+1FB00 with pattern 1
  // Patterns 0 (empty) and 63 (full) are skipped
  let pattern = codepoint - 0x1fb00 + 1;

  // Pattern 63 (all segments) is not in the range, but handle edge cases
  if (pattern >= 63) pattern++;

  return [
    (pattern & 0x01) !== 0,  // Segment 0 (top-left)
    (pattern & 0x02) !== 0,  // Segment 1 (top-right)
    (pattern & 0x04) !== 0,  // Segment 2 (middle-left)
    (pattern & 0x08) !== 0,  // Segment 3 (middle-right)
    (pattern & 0x10) !== 0,  // Segment 4 (bottom-left)
    (pattern & 0x20) !== 0,  // Segment 5 (bottom-right)
  ];
}

// ============================================================================
// Powerline / Geometric Triangle Rendering
// ============================================================================

/**
 * Triangle corner types for powerline-style characters
 */
type TriangleCorner = 'lower-right' | 'lower-left' | 'upper-left' | 'upper-right';

/**
 * Check if a codepoint is a corner triangle (◢◣◤◥)
 */
function isCornerTriangle(codepoint: number): boolean {
  return codepoint >= 0x25e2 && codepoint <= 0x25e5;
}

/**
 * Get the corner type for a triangle character
 */
function getTriangleCorner(codepoint: number): TriangleCorner | null {
  switch (codepoint) {
    case 0x25e2: return 'lower-right';  // ◢
    case 0x25e3: return 'lower-left';   // ◣
    case 0x25e4: return 'upper-left';   // ◤
    case 0x25e5: return 'upper-right';  // ◥
    default: return null;
  }
}

/**
 * Check if a codepoint is a powerline arrow/triangle
 * These are commonly used in terminal status lines
 */
function isPowerlineChar(codepoint: number): boolean {
  switch (codepoint) {
    // Powerline arrows (Private Use Area - common in Nerd Fonts)
    case 0xe0b0:  //  - right-pointing solid
    case 0xe0b2:  //  - left-pointing solid
    case 0xe0b4:  // Right-pointing triangle (alternate)
    case 0xe0b6:  // Left-pointing triangle (alternate)
    // Standard geometric shapes
    case 0x25b6:  // ▶ - right-pointing triangle
    case 0x25c0:  // ◀ - left-pointing triangle
    case 0x25b2:  // ▲ - up-pointing triangle
    case 0x25bc:  // ▼ - down-pointing triangle
    case 0x25ba:  // ► - right-pointing pointer
    case 0x25c4:  // ◄ - left-pointing pointer
      return true;
    default:
      return false;
  }
}

/**
 * Powerline/arrow triangle types
 */
type PowerlineType = 'right' | 'left' | 'up' | 'down';

/**
 * Get the direction for a powerline character
 */
function getPowerlineDirection(codepoint: number): PowerlineType | null {
  switch (codepoint) {
    case 0xe0b0:  //  - right solid
    case 0xe0b4:  // Right alternate
    case 0x25b6:  // ▶
    case 0x25ba:  // ►
      return 'right';
    case 0xe0b2:  //  - left solid
    case 0xe0b6:  // Left alternate
    case 0x25c0:  // ◀
    case 0x25c4:  // ◄
      return 'left';
    case 0x25b2:  // ▲
      return 'up';
    case 0x25bc:  // ▼
      return 'down';
    default:
      return null;
  }
}

// ============================================================================
// Legacy Computing Wedges and Smooth Mosaics (U+1FB3C-1FB8B)
// ============================================================================

/**
 * Wedge types - diagonal fills that occupy portions of the cell
 */
type WedgeType =
  | { type: 'diagonal'; from: 'bl' | 'br' | 'tl' | 'tr'; size: 'half' | 'small' | 'large' }
  | { type: 'half-scanline'; position: 'upper' | 'lower'; part: 'left' | 'right' };

/**
 * Check if a codepoint is a Legacy Computing wedge/diagonal (U+1FB3C-1FB8B)
 */
function isLegacyWedge(codepoint: number): boolean {
  return codepoint >= 0x1fb3c && codepoint <= 0x1fb8b;
}

/**
 * Get wedge configuration for Legacy Computing characters.
 * These are diagonal fills and partial blocks.
 */
function getLegacyWedgeType(codepoint: number): WedgeType | null {
  // Lower left triangular wedges (increasing size)
  if (codepoint >= 0x1fb3c && codepoint <= 0x1fb3f) {
    const sizes: ('small' | 'half' | 'large')[] = ['small', 'half', 'half', 'large'];
    return { type: 'diagonal', from: 'bl', size: sizes[codepoint - 0x1fb3c] || 'half' };
  }

  // Lower right triangular wedges
  if (codepoint >= 0x1fb40 && codepoint <= 0x1fb43) {
    const sizes: ('small' | 'half' | 'large')[] = ['small', 'half', 'half', 'large'];
    return { type: 'diagonal', from: 'br', size: sizes[codepoint - 0x1fb40] || 'half' };
  }

  // Upper left triangular wedges
  if (codepoint >= 0x1fb44 && codepoint <= 0x1fb47) {
    const sizes: ('small' | 'half' | 'large')[] = ['small', 'half', 'half', 'large'];
    return { type: 'diagonal', from: 'tl', size: sizes[codepoint - 0x1fb44] || 'half' };
  }

  // Upper right triangular wedges
  if (codepoint >= 0x1fb48 && codepoint <= 0x1fb4b) {
    const sizes: ('small' | 'half' | 'large')[] = ['small', 'half', 'half', 'large'];
    return { type: 'diagonal', from: 'tr', size: sizes[codepoint - 0x1fb48] || 'half' };
  }

  // Additional wedge patterns (simplified handling)
  if (codepoint >= 0x1fb4c && codepoint <= 0x1fb67) {
    // These are various diagonal combinations - treat as diagonal fills
    const idx = codepoint - 0x1fb4c;
    const corners: ('bl' | 'br' | 'tl' | 'tr')[] = ['bl', 'br', 'tl', 'tr'];
    return { type: 'diagonal', from: corners[idx % 4], size: 'half' };
  }

  // More wedge patterns (U+1FB68-1FB6F)
  if (codepoint >= 0x1fb68 && codepoint <= 0x1fb6f) {
    const corners: ('bl' | 'br' | 'tl' | 'tr')[] = ['bl', 'br', 'tl', 'tr'];
    return { type: 'diagonal', from: corners[(codepoint - 0x1fb68) % 4], size: 'large' };
  }

  // Vertical/horizontal eighths and scanlines (U+1FB70-1FB8B)
  if (codepoint >= 0x1fb70 && codepoint <= 0x1fb75) {
    // Vertical one-eighth blocks (left side)
    return { type: 'half-scanline', position: 'upper', part: 'left' };
  }

  if (codepoint >= 0x1fb76 && codepoint <= 0x1fb7b) {
    // Horizontal scanlines
    return { type: 'half-scanline', position: 'upper', part: 'right' };
  }

  if (codepoint >= 0x1fb7c && codepoint <= 0x1fb8b) {
    // Additional partial blocks
    const idx = codepoint - 0x1fb7c;
    return { type: 'half-scanline', position: idx < 8 ? 'upper' : 'lower', part: idx % 2 === 0 ? 'left' : 'right' };
  }

  return null;
}

// ============================================================================
// Octants (U+1CD00-1CDE5) - Symbols for Legacy Computing Supplement
// ============================================================================

/**
 * Check if a codepoint is an octant character
 * Octants are 2×4 grids where each of 8 cells can be filled (like Braille but blocks)
 */
function isOctant(codepoint: number): boolean {
  // Main octant range in Legacy Computing Supplement
  return codepoint >= 0x1cd00 && codepoint <= 0x1cde5;
}

/**
 * Get which cells are filled in an octant character.
 * Returns an array of 8 booleans for the 2×4 grid.
 * Layout:
 *   [0] [1]
 *   [2] [3]
 *   [4] [5]
 *   [6] [7]
 */
function getOctantCells(codepoint: number): boolean[] {
  // Octants encode their pattern in the codepoint offset
  // The encoding may vary - this is a simplified approach
  const pattern = codepoint - 0x1cd00;

  return [
    (pattern & 0x01) !== 0,
    (pattern & 0x02) !== 0,
    (pattern & 0x04) !== 0,
    (pattern & 0x08) !== 0,
    (pattern & 0x10) !== 0,
    (pattern & 0x20) !== 0,
    (pattern & 0x40) !== 0,
    (pattern & 0x80) !== 0,
  ];
}

// ============================================================================
// Smooth Mosaic Characters (U+1FB90-1FBAF)
// ============================================================================

/**
 * Check if a codepoint is a smooth mosaic character
 */
function isSmoothMosaic(codepoint: number): boolean {
  return codepoint >= 0x1fb90 && codepoint <= 0x1fbaf;
}

// ============================================================================
// Rounded Corner Box Drawing (╭╮╯╰)
// ============================================================================

/**
 * Check if a codepoint is a rounded corner character
 */
function isRoundedCorner(codepoint: number): boolean {
  return codepoint >= 0x256d && codepoint <= 0x2570;
}

/**
 * Get rounded corner type
 */
type RoundedCornerType = 'down-right' | 'down-left' | 'up-left' | 'up-right';

function getRoundedCornerType(codepoint: number): RoundedCornerType | null {
  switch (codepoint) {
    case 0x256d: return 'down-right';  // ╭
    case 0x256e: return 'down-left';   // ╮
    case 0x256f: return 'up-left';     // ╯
    case 0x2570: return 'up-right';    // ╰
    default: return null;
  }
}

// ============================================================================
// Dashed/Dotted Box Drawing Lines
// ============================================================================

/**
 * Dashed line configuration
 */
interface DashedLineConfig {
  direction: 'horizontal' | 'vertical';
  weight: 'light' | 'heavy';
  dashes: number;  // Number of dashes (2, 3, or 4)
}

/**
 * Check if a codepoint is a dashed box drawing character
 */
function isDashedLine(codepoint: number): boolean {
  return (
    (codepoint >= 0x2504 && codepoint <= 0x250b) ||  // Triple/quadruple dash
    (codepoint >= 0x254c && codepoint <= 0x254f)     // Double dash
  );
}

/**
 * Get dashed line configuration
 */
function getDashedLineConfig(codepoint: number): DashedLineConfig | null {
  switch (codepoint) {
    // Triple dash (3 dashes)
    case 0x2504: return { direction: 'horizontal', weight: 'light', dashes: 3 };  // ┄
    case 0x2505: return { direction: 'horizontal', weight: 'heavy', dashes: 3 };  // ┅
    case 0x2506: return { direction: 'vertical', weight: 'light', dashes: 3 };    // ┆
    case 0x2507: return { direction: 'vertical', weight: 'heavy', dashes: 3 };    // ┇

    // Quadruple dash (4 dashes)
    case 0x2508: return { direction: 'horizontal', weight: 'light', dashes: 4 };  // ┈
    case 0x2509: return { direction: 'horizontal', weight: 'heavy', dashes: 4 };  // ┉
    case 0x250a: return { direction: 'vertical', weight: 'light', dashes: 4 };    // ┊
    case 0x250b: return { direction: 'vertical', weight: 'heavy', dashes: 4 };    // ┋

    // Double dash (2 dashes)
    case 0x254c: return { direction: 'horizontal', weight: 'light', dashes: 2 };  // ╌
    case 0x254d: return { direction: 'horizontal', weight: 'heavy', dashes: 2 };  // ╍
    case 0x254e: return { direction: 'vertical', weight: 'light', dashes: 2 };    // ╎
    case 0x254f: return { direction: 'vertical', weight: 'heavy', dashes: 2 };    // ╏

    default: return null;
  }
}

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure using a representative character
    const metrics = ctx.measureText('M');

    // Use font's declared metrics (fontBoundingBox) instead of actual rendered pixels.
    // This matches how native Ghostty uses the font's published metrics rather than
    // character-specific measurements. fontBoundingBox* represents the font's declared
    // ascender/descender values which are consistent regardless of which glyphs are rendered.
    // Fall back to actualBoundingBox for older browsers that don't support fontBoundingBox.
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? this.fontSize * 0.8;
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? this.fontSize * 0.2;

    // For width, use the measured advance width of 'M' for monospace fonts.
    // All characters should have the same width in a monospace font.
    const width = Math.ceil(metrics.width);

    // Height is the font's declared ascent + descent (no extra padding needed since
    // fontBoundingBox already accounts for the full vertical extent of all glyphs)
    const height = Math.ceil(ascent + descent);
    const baseline = Math.ceil(ascent);

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed or if blinking (need to redraw cursor line)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink) {
      // Mark cursor lines as needing redraw
      if (!forceAll && !buffer.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        const line = buffer.getLine(cursor.y);
        if (line) {
          this.renderLine(line, cursor.y, dims.cols);
        }
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAll && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          const line = buffer.getLine(this.lastCursorPosition.y);
          if (line) {
            this.renderLine(line, this.lastCursorPosition.y, dims.cols);
          }
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0) {
          if (y < viewportY && scrollbackProvider) {
            // This row is from scrollback
            // Floor viewportY for array access (handles fractional values during smooth scroll)
            const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
            line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          } else {
            // This row is from visible screen
            const screenRow = y - Math.floor(viewportY);
            line = buffer.getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = buffer.getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Track if anything was actually rendered
    let anyLinesRendered = false;

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        viewportY > 0
          ? true
          : forceAll || buffer.isRowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      anyLinesRendered = true;

      // Fetch line from scrollback or visible screen
      let line: GhosttyCell[] | null = null;
      if (viewportY > 0) {
        // Scrolled up - need to fetch from scrollback + visible screen
        // When scrolled up N lines, we want to show:
        // - Scrollback lines (from the end) + visible screen lines

        // Check if this row should come from scrollback or visible screen
        if (y < viewportY && scrollbackProvider) {
          // This row is from scrollback (upper part of viewport)
          // Get from end of scrollback buffer
          // Floor viewportY for array access (handles fractional values during smooth scroll)
          const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
          line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
        } else {
          // This row is from visible screen (lower part of viewport)
          const screenRow = viewportY > 0 ? y - Math.floor(viewportY) : y;
          line = buffer.getLine(screenRow);
        }
      } else {
        // At bottom - fetch from visible screen
        line = buffer.getLine(y);
      }

      if (line) {
        this.renderLine(line, y, dims.cols);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (unless suppressed during snapshot loading or cursor is hidden by app)
    const shouldDrawCursor = viewportY === 0 && cursor.visible && this.cursorVisible && !this.cursorSuppressed;
    if (shouldDrawCursor) {
      this.renderCursor(cursor.x, cursor.y);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;

    // Clear line background with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, cols * this.metrics.width, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Only draw cell background if it's different from the default (black)
    // This lets the theme background (drawn earlier) show through for default cells
    const isDefaultBg = bg_r === 0 && bg_g === 0 && bg_b === 0;
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text style
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use selection foreground if selected
    if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else {
      // Extract colors and handle inverse
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;

      if (cell.flags & CellFlags.INVERSE) {
        // When inverted, foreground becomes background
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }

      this.ctx.fillStyle = this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Check for special characters that need procedural rendering
    // instead of font glyphs to ensure seamless display without gaps
    const codepoint = cell.codepoint || 32;
    const fgColor = this.ctx.fillStyle as string;

    // Box-drawing characters (U+2500-257F)
    if (isBoxDrawingChar(codepoint)) {
      this.drawBoxChar(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Block element characters (U+2580-259F)
    if (isBlockElement(codepoint)) {
      this.drawBlockChar(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Braille patterns (U+2800-28FF)
    if (isBraillePattern(codepoint)) {
      this.drawBrailleChar(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Sextant characters (U+1FB00-1FB3B)
    if (isSextant(codepoint)) {
      this.drawSextantChar(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Corner triangles (◢◣◤◥ U+25E2-25E5)
    if (isCornerTriangle(codepoint)) {
      this.drawCornerTriangle(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Powerline arrows and directional triangles
    if (isPowerlineChar(codepoint)) {
      this.drawPowerlineChar(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Legacy Computing wedges and diagonal fills (U+1FB3C-1FB8B)
    if (isLegacyWedge(codepoint)) {
      this.drawLegacyWedge(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Octants - 2×4 block grids (U+1CD00-1CDE5)
    if (isOctant(codepoint)) {
      this.drawOctant(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Smooth mosaic characters (U+1FB90-1FBAF)
    if (isSmoothMosaic(codepoint)) {
      this.drawSmoothMosaic(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Rounded corner characters (╭╮╯╰)
    if (isRoundedCorner(codepoint)) {
      this.drawRoundedCorner(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Dashed/dotted box drawing lines
    if (isDashedLine(codepoint)) {
      this.drawDashedLine(codepoint, cellX, cellY, fgColor);
      if (cell.flags & CellFlags.FAINT) {
        this.ctx.globalAlpha = 1.0;
      }
      return;
    }

    // Get the character to render - use grapheme lookup for complex scripts
    let char: string;
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      // Cell has additional codepoints - get full grapheme cluster
      char = this.currentBuffer.getGraphemeString(y, x);
    } else {
      // Simple cell - single codepoint
      char = String.fromCodePoint(codepoint); // Default to space if null
    }
    this.ctx.fillText(char, textX, textY);

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  // ==========================================================================
  // Box-Drawing Character Rendering
  // ==========================================================================

  /**
   * Draw a box-drawing character using filled rectangles instead of font glyphs.
   * This ensures continuous lines with no gaps at cell boundaries.
   *
   * @param codepoint The Unicode codepoint (U+2500-257F)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawBoxChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const lines = getBoxLines(codepoint);
    if (!lines) return;

    const width = this.metrics.width;
    const height = this.metrics.height;

    // Calculate line thicknesses based on cell height
    // Using height/12 as base for light lines (similar to Ghostty's approach)
    const lightThickness = Math.max(1, Math.round(height / 12));
    const heavyThickness = Math.max(2, Math.round(height / 6));

    // For double lines: two parallel lines with a gap between
    const doubleGap = Math.max(2, Math.round(height / 8));
    const doubleLineThickness = Math.max(1, Math.round(height / 16));

    // Center point of the cell
    const centerX = cellX + width / 2;
    const centerY = cellY + height / 2;

    this.ctx.fillStyle = fgColor;

    // Helper to get thickness for a line style
    const getThickness = (style: LineStyle): number => {
      switch (style) {
        case 'light':
          return lightThickness;
        case 'heavy':
          return heavyThickness;
        case 'double':
          return doubleLineThickness;
        default:
          return 0;
      }
    };

    // Draw horizontal segments (left and right)
    if (lines.left !== 'none' || lines.right !== 'none') {
      if (lines.left === 'double' || lines.right === 'double') {
        // Double horizontal lines
        const offset = (doubleGap + doubleLineThickness) / 2;

        if (lines.left !== 'none') {
          // Left segment - upper line
          this.ctx.fillRect(
            cellX,
            centerY - offset - doubleLineThickness / 2,
            width / 2 + (lines.right !== 'none' ? doubleLineThickness / 2 : 0),
            doubleLineThickness
          );
          // Left segment - lower line
          this.ctx.fillRect(
            cellX,
            centerY + offset - doubleLineThickness / 2,
            width / 2 + (lines.right !== 'none' ? doubleLineThickness / 2 : 0),
            doubleLineThickness
          );
        }
        if (lines.right !== 'none') {
          // Right segment - upper line
          this.ctx.fillRect(
            centerX - (lines.left !== 'none' ? doubleLineThickness / 2 : 0),
            centerY - offset - doubleLineThickness / 2,
            width / 2 + (lines.left !== 'none' ? doubleLineThickness / 2 : 0),
            doubleLineThickness
          );
          // Right segment - lower line
          this.ctx.fillRect(
            centerX - (lines.left !== 'none' ? doubleLineThickness / 2 : 0),
            centerY + offset - doubleLineThickness / 2,
            width / 2 + (lines.left !== 'none' ? doubleLineThickness / 2 : 0),
            doubleLineThickness
          );
        }
      } else {
        // Single horizontal lines (light or heavy)
        const leftThickness = getThickness(lines.left);
        const rightThickness = getThickness(lines.right);

        // If both directions have the same style, draw one continuous line
        // This avoids sub-pixel gaps at the center
        if (lines.left !== 'none' && lines.right !== 'none' && lines.left === lines.right) {
          const thickness = leftThickness;
          // Draw full width - edge to edge
          this.ctx.fillRect(
            cellX,
            Math.round(centerY - thickness / 2),
            width,
            thickness
          );
        } else {
          // Different styles or only one direction - draw segments
          // For corners (one horizontal + one vertical), don't extend past center
          // to avoid overlap bumps
          if (lines.left !== 'none') {
            const thickness = leftThickness;
            // Left edge to center (only extend past if there's a right segment)
            const extendPastCenter = lines.right !== 'none' ? thickness / 2 : 0;
            this.ctx.fillRect(
              cellX,
              Math.round(centerY - thickness / 2),
              Math.ceil(width / 2 + extendPastCenter),
              thickness
            );
          }
          if (lines.right !== 'none') {
            const thickness = rightThickness;
            // Center to right edge (only extend past if there's a left segment)
            const extendPastCenter = lines.left !== 'none' ? thickness / 2 : 0;
            this.ctx.fillRect(
              Math.floor(centerX - extendPastCenter),
              Math.round(centerY - thickness / 2),
              Math.ceil(width / 2 + extendPastCenter),
              thickness
            );
          }
        }
      }
    }

    // Draw vertical segments (up and down)
    if (lines.up !== 'none' || lines.down !== 'none') {
      if (lines.up === 'double' || lines.down === 'double') {
        // Double vertical lines
        const offset = (doubleGap + doubleLineThickness) / 2;

        if (lines.up !== 'none') {
          // Up segment - left line
          this.ctx.fillRect(
            Math.round(centerX - offset - doubleLineThickness / 2),
            cellY,
            doubleLineThickness,
            Math.ceil(height / 2 + doubleLineThickness / 2)
          );
          // Up segment - right line
          this.ctx.fillRect(
            Math.round(centerX + offset - doubleLineThickness / 2),
            cellY,
            doubleLineThickness,
            Math.ceil(height / 2 + doubleLineThickness / 2)
          );
        }
        if (lines.down !== 'none') {
          // Down segment - left line
          this.ctx.fillRect(
            Math.round(centerX - offset - doubleLineThickness / 2),
            Math.floor(centerY - doubleLineThickness / 2),
            doubleLineThickness,
            Math.ceil(height / 2 + doubleLineThickness / 2)
          );
          // Down segment - right line
          this.ctx.fillRect(
            Math.round(centerX + offset - doubleLineThickness / 2),
            Math.floor(centerY - doubleLineThickness / 2),
            doubleLineThickness,
            Math.ceil(height / 2 + doubleLineThickness / 2)
          );
        }
      } else {
        // Single vertical lines (light or heavy)
        const upThickness = getThickness(lines.up);
        const downThickness = getThickness(lines.down);

        // If both directions have the same style, draw one continuous line
        if (lines.up !== 'none' && lines.down !== 'none' && lines.up === lines.down) {
          const thickness = upThickness;
          // Draw full height - edge to edge
          this.ctx.fillRect(
            Math.round(centerX - thickness / 2),
            cellY,
            thickness,
            height
          );
        } else {
          // Different styles or only one direction - draw segments
          // For corners (one horizontal + one vertical), don't extend past center
          if (lines.up !== 'none') {
            const thickness = upThickness;
            // Top edge to center (only extend past if there's a down segment)
            const extendPastCenter = lines.down !== 'none' ? thickness / 2 : 0;
            this.ctx.fillRect(
              Math.round(centerX - thickness / 2),
              cellY,
              thickness,
              Math.ceil(height / 2 + extendPastCenter)
            );
          }
          if (lines.down !== 'none') {
            const thickness = downThickness;
            // Center to bottom edge (only extend past if there's an up segment)
            const extendPastCenter = lines.up !== 'none' ? thickness / 2 : 0;
            this.ctx.fillRect(
              Math.round(centerX - thickness / 2),
              Math.floor(centerY - extendPastCenter),
              thickness,
              Math.ceil(height / 2 + extendPastCenter)
            );
          }
        }
      }
    }
  }

  /**
   * Draw a block element character using filled rectangles.
   * This ensures seamless rendering with no gaps at cell boundaries.
   *
   * @param codepoint The Unicode codepoint (U+2580-259F)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawBlockChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const block = getBlockType(codepoint);
    if (!block) return;

    const width = this.metrics.width;
    const height = this.metrics.height;

    this.ctx.fillStyle = fgColor;

    switch (block.type) {
      case 'full':
        // Full block - fill entire cell
        this.ctx.fillRect(cellX, cellY, width, height);
        break;

      case 'upper':
        // Upper N/8 of cell
        const upperHeight = Math.round((height * block.eighths) / 8);
        this.ctx.fillRect(cellX, cellY, width, upperHeight);
        break;

      case 'lower':
        // Lower N/8 of cell
        const lowerHeight = Math.round((height * block.eighths) / 8);
        this.ctx.fillRect(cellX, cellY + height - lowerHeight, width, lowerHeight);
        break;

      case 'left':
        // Left N/8 of cell
        const leftWidth = Math.round((width * block.eighths) / 8);
        this.ctx.fillRect(cellX, cellY, leftWidth, height);
        break;

      case 'right':
        // Right N/8 of cell
        const rightWidth = Math.round((width * block.eighths) / 8);
        this.ctx.fillRect(cellX + width - rightWidth, cellY, rightWidth, height);
        break;

      case 'quadrants':
        // Each quadrant is half width and half height
        const halfW = Math.ceil(width / 2);
        const halfH = Math.ceil(height / 2);
        const midX = cellX + Math.floor(width / 2);
        const midY = cellY + Math.floor(height / 2);

        if (block.tl) {
          this.ctx.fillRect(cellX, cellY, halfW, halfH);
        }
        if (block.tr) {
          this.ctx.fillRect(midX, cellY, halfW, halfH);
        }
        if (block.bl) {
          this.ctx.fillRect(cellX, midY, halfW, halfH);
        }
        if (block.br) {
          this.ctx.fillRect(midX, midY, halfW, halfH);
        }
        break;

      case 'shade':
        // Shades are rendered using a pattern of dots/pixels
        // For simplicity, we use globalAlpha to simulate the shade
        this.ctx.globalAlpha = block.density;
        this.ctx.fillRect(cellX, cellY, width, height);
        this.ctx.globalAlpha = 1.0;
        break;
    }
  }

  /**
   * Draw a Braille pattern character using filled circles/rectangles.
   * Braille patterns are 2×4 grids of dots.
   *
   * @param codepoint The Unicode codepoint (U+2800-28FF)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawBrailleChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const dots = getBrailleDots(codepoint);

    const width = this.metrics.width;
    const height = this.metrics.height;

    // Calculate dot size and spacing
    // Dots are arranged in a 2×4 grid with some padding
    const paddingX = width * 0.15;
    const paddingY = height * 0.1;
    const dotAreaWidth = width - paddingX * 2;
    const dotAreaHeight = height - paddingY * 2;

    // Dot radius - make dots touch or slightly overlap for continuous lines
    const dotRadius = Math.max(1, Math.min(dotAreaWidth / 4, dotAreaHeight / 8) * 0.9);

    // Spacing between dot centers
    const colSpacing = dotAreaWidth;  // Only 2 columns, so full width between them
    const rowSpacing = dotAreaHeight / 3;  // 4 rows, so divide by 3 gaps

    // Starting position (center of first dot)
    const startX = cellX + paddingX + dotRadius;
    const startY = cellY + paddingY + dotRadius;

    this.ctx.fillStyle = fgColor;

    // Dot positions map: [dotIndex] -> [col, row]
    // Dots 1,2,3,7 are in left column (col 0)
    // Dots 4,5,6,8 are in right column (col 1)
    const dotPositions: [number, number][] = [
      [0, 0],  // Dot 1: top-left
      [0, 1],  // Dot 2: middle-upper-left
      [0, 2],  // Dot 3: middle-lower-left
      [1, 0],  // Dot 4: top-right
      [1, 1],  // Dot 5: middle-upper-right
      [1, 2],  // Dot 6: middle-lower-right
      [0, 3],  // Dot 7: bottom-left
      [1, 3],  // Dot 8: bottom-right
    ];

    for (let i = 0; i < 8; i++) {
      if (dots[i]) {
        const [col, row] = dotPositions[i];
        const dotX = startX + col * colSpacing;
        const dotY = startY + row * rowSpacing;

        // Draw dot as a filled circle
        this.ctx.beginPath();
        this.ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
  }

  /**
   * Draw a sextant character using filled rectangles.
   * Sextants are 2×3 grids (6 segments).
   *
   * @param codepoint The Unicode codepoint (U+1FB00-1FB3B)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawSextantChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const segments = getSextantSegments(codepoint);

    const width = this.metrics.width;
    const height = this.metrics.height;

    // Each segment is 1/2 width and 1/3 height
    const segW = Math.ceil(width / 2);
    const segH = Math.ceil(height / 3);

    this.ctx.fillStyle = fgColor;

    // Segment positions: [index] -> [col, row]
    // Grid is 2 columns × 3 rows
    const segmentPositions: [number, number][] = [
      [0, 0],  // Segment 0: top-left
      [1, 0],  // Segment 1: top-right
      [0, 1],  // Segment 2: middle-left
      [1, 1],  // Segment 3: middle-right
      [0, 2],  // Segment 4: bottom-left
      [1, 2],  // Segment 5: bottom-right
    ];

    for (let i = 0; i < 6; i++) {
      if (segments[i]) {
        const [col, row] = segmentPositions[i];
        const segX = cellX + col * Math.floor(width / 2);
        const segY = cellY + row * Math.floor(height / 3);

        // For rightmost column, extend to cell edge
        const actualW = col === 1 ? width - Math.floor(width / 2) : segW;
        // For bottom row, extend to cell edge
        const actualH = row === 2 ? height - Math.floor(height / 3) * 2 : segH;

        this.ctx.fillRect(segX, segY, actualW, actualH);
      }
    }
  }

  /**
   * Draw a corner triangle character (◢◣◤◥)
   *
   * @param codepoint The Unicode codepoint (U+25E2-25E5)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawCornerTriangle(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const corner = getTriangleCorner(codepoint);
    if (!corner) return;

    const width = this.metrics.width;
    const height = this.metrics.height;

    this.ctx.fillStyle = fgColor;
    this.ctx.beginPath();

    // Define triangle vertices based on corner type
    switch (corner) {
      case 'lower-right':  // ◢ - triangle in lower-right corner
        this.ctx.moveTo(cellX + width, cellY);        // top-right
        this.ctx.lineTo(cellX + width, cellY + height); // bottom-right
        this.ctx.lineTo(cellX, cellY + height);       // bottom-left
        break;

      case 'lower-left':   // ◣ - triangle in lower-left corner
        this.ctx.moveTo(cellX, cellY);                // top-left
        this.ctx.lineTo(cellX + width, cellY + height); // bottom-right
        this.ctx.lineTo(cellX, cellY + height);       // bottom-left
        break;

      case 'upper-left':   // ◤ - triangle in upper-left corner
        this.ctx.moveTo(cellX, cellY);                // top-left
        this.ctx.lineTo(cellX + width, cellY);        // top-right
        this.ctx.lineTo(cellX, cellY + height);       // bottom-left
        break;

      case 'upper-right':  // ◥ - triangle in upper-right corner
        this.ctx.moveTo(cellX, cellY);                // top-left
        this.ctx.lineTo(cellX + width, cellY);        // top-right
        this.ctx.lineTo(cellX + width, cellY + height); // bottom-right
        break;
    }

    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * Draw a powerline arrow/triangle character
   * These fill the entire cell height and point in a direction
   *
   * @param codepoint The Unicode codepoint
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawPowerlineChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const direction = getPowerlineDirection(codepoint);
    if (!direction) return;

    const width = this.metrics.width;
    const height = this.metrics.height;

    this.ctx.fillStyle = fgColor;
    this.ctx.beginPath();

    // Powerline arrows span the full cell height
    switch (direction) {
      case 'right':  // Arrow pointing right (like  or ▶)
        this.ctx.moveTo(cellX, cellY);                // top-left
        this.ctx.lineTo(cellX + width, cellY + height / 2); // middle-right (point)
        this.ctx.lineTo(cellX, cellY + height);       // bottom-left
        break;

      case 'left':   // Arrow pointing left (like  or ◀)
        this.ctx.moveTo(cellX + width, cellY);        // top-right
        this.ctx.lineTo(cellX, cellY + height / 2);   // middle-left (point)
        this.ctx.lineTo(cellX + width, cellY + height); // bottom-right
        break;

      case 'up':     // Arrow pointing up (▲)
        this.ctx.moveTo(cellX, cellY + height);       // bottom-left
        this.ctx.lineTo(cellX + width / 2, cellY);    // top-center (point)
        this.ctx.lineTo(cellX + width, cellY + height); // bottom-right
        break;

      case 'down':   // Arrow pointing down (▼)
        this.ctx.moveTo(cellX, cellY);                // top-left
        this.ctx.lineTo(cellX + width / 2, cellY + height); // bottom-center (point)
        this.ctx.lineTo(cellX + width, cellY);        // top-right
        break;
    }

    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * Draw a Legacy Computing wedge/diagonal character
   *
   * @param codepoint The Unicode codepoint (U+1FB3C-1FB8B)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawLegacyWedge(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const wedge = getLegacyWedgeType(codepoint);
    if (!wedge) return;

    const width = this.metrics.width;
    const height = this.metrics.height;

    this.ctx.fillStyle = fgColor;
    this.ctx.beginPath();

    if (wedge.type === 'diagonal') {
      // Calculate size factor based on wedge size
      let sizeFactor: number;
      switch (wedge.size) {
        case 'small': sizeFactor = 0.33; break;
        case 'half': sizeFactor = 0.5; break;
        case 'large': sizeFactor = 0.67; break;
      }

      // Draw triangular wedge from specified corner
      switch (wedge.from) {
        case 'bl':  // Bottom-left corner
          this.ctx.moveTo(cellX, cellY + height);
          this.ctx.lineTo(cellX + width * sizeFactor, cellY + height);
          this.ctx.lineTo(cellX, cellY + height * (1 - sizeFactor));
          break;

        case 'br':  // Bottom-right corner
          this.ctx.moveTo(cellX + width, cellY + height);
          this.ctx.lineTo(cellX + width * (1 - sizeFactor), cellY + height);
          this.ctx.lineTo(cellX + width, cellY + height * (1 - sizeFactor));
          break;

        case 'tl':  // Top-left corner
          this.ctx.moveTo(cellX, cellY);
          this.ctx.lineTo(cellX + width * sizeFactor, cellY);
          this.ctx.lineTo(cellX, cellY + height * sizeFactor);
          break;

        case 'tr':  // Top-right corner
          this.ctx.moveTo(cellX + width, cellY);
          this.ctx.lineTo(cellX + width * (1 - sizeFactor), cellY);
          this.ctx.lineTo(cellX + width, cellY + height * sizeFactor);
          break;
      }
    } else if (wedge.type === 'half-scanline') {
      // Half-cell rectangles (upper/lower, left/right)
      const halfW = width / 2;
      const halfH = height / 2;

      const startX = wedge.part === 'left' ? cellX : cellX + halfW;
      const startY = wedge.position === 'upper' ? cellY : cellY + halfH;

      this.ctx.fillRect(startX, startY, halfW, halfH);
      return; // fillRect doesn't need closePath/fill
    }

    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * Draw an octant character (2×4 grid of filled blocks)
   *
   * @param codepoint The Unicode codepoint (U+1CD00-1CDE5)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawOctant(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const cells = getOctantCells(codepoint);

    const width = this.metrics.width;
    const height = this.metrics.height;

    // Octants are 2×4 grids
    const cellW = Math.ceil(width / 2);
    const cellH = Math.ceil(height / 4);

    this.ctx.fillStyle = fgColor;

    // Cell positions: [index] -> [col, row]
    const positions: [number, number][] = [
      [0, 0], [1, 0],  // Row 0
      [0, 1], [1, 1],  // Row 1
      [0, 2], [1, 2],  // Row 2
      [0, 3], [1, 3],  // Row 3
    ];

    for (let i = 0; i < 8; i++) {
      if (cells[i]) {
        const [col, row] = positions[i];
        const x = cellX + col * Math.floor(width / 2);
        const y = cellY + row * Math.floor(height / 4);

        // Extend to cell edges for rightmost/bottom cells
        const w = col === 1 ? width - Math.floor(width / 2) : cellW;
        const h = row === 3 ? height - Math.floor(height / 4) * 3 : cellH;

        this.ctx.fillRect(x, y, w, h);
      }
    }
  }

  /**
   * Draw a smooth mosaic character
   * These are combinations of diagonal fills and block elements
   *
   * @param codepoint The Unicode codepoint (U+1FB90-1FBAF)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawSmoothMosaic(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const width = this.metrics.width;
    const height = this.metrics.height;

    this.ctx.fillStyle = fgColor;

    // Smooth mosaics have various patterns - handle common ones
    const offset = codepoint - 0x1fb90;

    // These are typically combinations of quarters and diagonals
    // Simplified handling: draw based on pattern index
    this.ctx.beginPath();

    if (offset < 8) {
      // Diagonal patterns
      const corners = ['bl', 'br', 'tl', 'tr'];
      const corner = corners[offset % 4];

      switch (corner) {
        case 'bl':
          this.ctx.moveTo(cellX, cellY + height);
          this.ctx.lineTo(cellX + width, cellY + height);
          this.ctx.lineTo(cellX, cellY);
          break;
        case 'br':
          this.ctx.moveTo(cellX + width, cellY + height);
          this.ctx.lineTo(cellX, cellY + height);
          this.ctx.lineTo(cellX + width, cellY);
          break;
        case 'tl':
          this.ctx.moveTo(cellX, cellY);
          this.ctx.lineTo(cellX + width, cellY);
          this.ctx.lineTo(cellX, cellY + height);
          break;
        case 'tr':
          this.ctx.moveTo(cellX + width, cellY);
          this.ctx.lineTo(cellX, cellY);
          this.ctx.lineTo(cellX + width, cellY + height);
          break;
      }
    } else {
      // Checker and other patterns - draw as half block
      this.ctx.fillRect(cellX, cellY, width / 2, height / 2);
      this.ctx.fillRect(cellX + width / 2, cellY + height / 2, width / 2, height / 2);
      return;
    }

    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * Draw a rounded corner character using arc curves.
   * Replaces font glyphs with smooth curved corners.
   *
   * @param codepoint The Unicode codepoint (U+256D-2570)
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawRoundedCorner(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const width = this.metrics.width;
    const height = this.metrics.height;
    const thickness = Math.max(1, Math.round(height / 12));

    const centerX = Math.round(cellX + width / 2);
    const centerY = Math.round(cellY + height / 2);
    const radius = Math.min(width, height) / 2 - thickness / 2;

    this.ctx.strokeStyle = fgColor;
    this.ctx.lineWidth = thickness;
    this.ctx.lineCap = 'square';
    this.ctx.beginPath();

    const cornerType = getRoundedCornerType(codepoint);

    switch (cornerType) {
      case 'down-right': // ╭ - arc from top to right
        // Arc from center-top going to center-right
        this.ctx.arc(centerX + radius, centerY + radius, radius, Math.PI, Math.PI * 1.5);
        // Extend lines to cell edges
        this.ctx.moveTo(centerX, Math.round(cellY + height / 2 - radius));
        this.ctx.lineTo(centerX, cellY);
        this.ctx.moveTo(Math.round(cellX + width / 2 + radius), centerY);
        this.ctx.lineTo(cellX + width, centerY);
        break;

      case 'down-left': // ╮ - arc from left to bottom
        this.ctx.arc(centerX - radius, centerY + radius, radius, Math.PI * 1.5, Math.PI * 2);
        this.ctx.moveTo(centerX, Math.round(cellY + height / 2 - radius));
        this.ctx.lineTo(centerX, cellY);
        this.ctx.moveTo(Math.round(cellX + width / 2 - radius), centerY);
        this.ctx.lineTo(cellX, centerY);
        break;

      case 'up-left': // ╯ - arc from bottom to left
        this.ctx.arc(centerX - radius, centerY - radius, radius, 0, Math.PI * 0.5);
        this.ctx.moveTo(centerX, Math.round(cellY + height / 2 + radius));
        this.ctx.lineTo(centerX, cellY + height);
        this.ctx.moveTo(Math.round(cellX + width / 2 - radius), centerY);
        this.ctx.lineTo(cellX, centerY);
        break;

      case 'up-right': // ╰ - arc from right to top
        this.ctx.arc(centerX + radius, centerY - radius, radius, Math.PI * 0.5, Math.PI);
        this.ctx.moveTo(centerX, Math.round(cellY + height / 2 + radius));
        this.ctx.lineTo(centerX, cellY + height);
        this.ctx.moveTo(Math.round(cellX + width / 2 + radius), centerY);
        this.ctx.lineTo(cellX + width, centerY);
        break;
    }

    this.ctx.stroke();
  }

  /**
   * Draw a dashed/dotted box drawing line.
   *
   * @param codepoint The Unicode codepoint
   * @param cellX The X position of the cell in pixels
   * @param cellY The Y position of the cell in pixels
   * @param fgColor The foreground color to use
   */
  private drawDashedLine(
    codepoint: number,
    cellX: number,
    cellY: number,
    fgColor: string
  ): void {
    const config = getDashedLineConfig(codepoint);
    if (!config) return;

    const width = this.metrics.width;
    const height = this.metrics.height;
    const baseThickness = Math.max(1, Math.round(height / 12));
    const thickness = config.weight === 'heavy' ? baseThickness * 2 : baseThickness;

    this.ctx.fillStyle = fgColor;

    const centerX = Math.round(cellX + width / 2);
    const centerY = Math.round(cellY + height / 2);

    if (config.direction === 'horizontal') {
      // Horizontal dashes
      const dashWidth = width / (config.dashes * 2 - 1);
      const y = Math.round(centerY - thickness / 2);

      for (let i = 0; i < config.dashes; i++) {
        const x = Math.round(cellX + i * dashWidth * 2);
        this.ctx.fillRect(x, y, Math.round(dashWidth), thickness);
      }
    } else {
      // Vertical dashes
      const dashHeight = height / (config.dashes * 2 - 1);
      const x = Math.round(centerX - thickness / 2);

      for (let i = 0; i < config.dashes; i++) {
        const y = Math.round(cellY + i * dashHeight * 2);
        this.ctx.fillRect(x, y, thickness, Math.round(dashHeight));
      }
    }
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Note: Render loop should redraw cursor line automatically
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Suppress cursor rendering temporarily.
   * Use this during snapshot loading to prevent ghost cursors at intermediate positions.
   */
  private cursorSuppressed: boolean = false;

  public suppressCursor(suppress: boolean): void {
    this.cursorSuppressed = suppress;
  }

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}
