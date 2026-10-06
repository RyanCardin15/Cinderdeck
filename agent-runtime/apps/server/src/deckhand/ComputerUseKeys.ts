// Parses X keysym-style chords ("Control_L+Shift_L+period", "super+s") into
// macOS virtual key codes (ANSI layout) plus modifiers for the native helper.

export type ComputerModifier = "command" | "shift" | "option" | "control" | "function";
export type ParsedKey =
  | { readonly keyCode: number; readonly modifiers: ReadonlyArray<ComputerModifier> }
  | { readonly text: string; readonly modifiers: ReadonlyArray<ComputerModifier> };

const modifierNames: Record<string, ComputerModifier> = {
  control: "control",
  control_l: "control",
  control_r: "control",
  ctrl: "control",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  alt: "option",
  alt_l: "option",
  alt_r: "option",
  option: "option",
  opt: "option",
  super: "command",
  super_l: "command",
  super_r: "command",
  cmd: "command",
  command: "command",
  meta: "command",
  meta_l: "command",
  meta_r: "command",
  fn: "function",
};

// Unshifted characters on the ANSI layout.
const characterCodes: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
  " ": 49,
};

// Characters typed with Shift on the ANSI layout, mapped to their base key.
const shiftedCharacters: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

const keysymCharacters: Record<string, string> = {
  space: " ",
  period: ".",
  comma: ",",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  quoteright: "'",
  grave: "`",
  quoteleft: "`",
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  exclam: "!",
  at: "@",
  numbersign: "#",
  dollar: "$",
  percent: "%",
  asciicircum: "^",
  ampersand: "&",
  asterisk: "*",
  parenleft: "(",
  parenright: ")",
  underscore: "_",
  plus: "+",
  braceleft: "{",
  braceright: "}",
  bar: "|",
  colon: ":",
  quotedbl: '"',
  less: "<",
  greater: ">",
  question: "?",
  asciitilde: "~",
};

const namedCodes: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  backspace: 51,
  escape: 53,
  esc: 53,
  delete: 117,
  del: 117,
  home: 115,
  end: 119,
  page_up: 116,
  pageup: 116,
  prior: 116,
  page_down: 121,
  pagedown: 121,
  next: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  arrowleft: 123,
  arrowright: 124,
  arrowdown: 125,
  arrowup: 126,
  help: 114,
  insert: 114,
  caps_lock: 57,
  kp_enter: 76,
  kp_decimal: 65,
  kp_multiply: 67,
  kp_add: 69,
  kp_subtract: 78,
  kp_divide: 75,
  kp_equal: 81,
  kp_0: 82,
  kp_1: 83,
  kp_2: 84,
  kp_3: 85,
  kp_4: 86,
  kp_5: 87,
  kp_6: 88,
  kp_7: 89,
  kp_8: 91,
  kp_9: 92,
  numpad_0: 82,
  numpad_1: 83,
  numpad_2: 84,
  numpad_3: 85,
  numpad_4: 86,
  numpad_5: 87,
  numpad_6: 88,
  numpad_7: 89,
  numpad_8: 91,
  numpad_9: 92,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
};

export function parseKeyChord(input: string): ParsedKey | null {
  let raw = input.trim();
  // A bare "+" or a trailing "++" ("super++") names the plus key itself.
  const plusKey = raw === "+" || raw.endsWith("++");
  if (plusKey) raw = raw === "+" ? "" : raw.slice(0, -2);
  const parts = raw === "" ? [] : raw.split("+").map((part) => part.trim());
  if (plusKey) parts.push("+");
  if (parts.length === 0 || parts.some((part) => part === "")) return null;
  const modifiers = new Set<ComputerModifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = modifierNames[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  const last = parts[parts.length - 1]!;
  const lowerLast = last.toLowerCase();
  if (modifierNames[lowerLast]) return null;
  const named = namedCodes[lowerLast];
  if (named !== undefined) return { keyCode: named, modifiers: [...modifiers] };
  const character = [...last].length === 1 ? last : keysymCharacters[lowerLast];
  if (character === undefined) return null;
  const unshifted = shiftedCharacters[character];
  if (unshifted !== undefined) {
    modifiers.add("shift");
    return { keyCode: characterCodes[unshifted]!, modifiers: [...modifiers] };
  }
  const lower = character.toLowerCase();
  const code = characterCodes[lower];
  if (code !== undefined) {
    if (lower !== character) modifiers.add("shift");
    return { keyCode: code, modifiers: [...modifiers] };
  }
  // Other characters (é, ß, emoji) are typed directly when no modifier is held.
  return modifiers.size === 0 ? { text: character, modifiers: [] } : null;
}
