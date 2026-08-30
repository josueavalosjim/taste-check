/**
 * Colour parsing and the WCAG contrast arithmetic.
 *
 * The maths here is the standard sRGB relative-luminance formula, but two
 * details are worth stating because they are the reason a naive contrast
 * checker disagrees with a browser:
 *
 *   1. Alpha is composited, not ignored. A token like `rgb(0 0 0 / 0.58)` is
 *      not a 21:1 black; it is whatever it becomes over the ground behind it.
 *      Measuring the raw value is measuring a colour that is never painted.
 *
 *   2. A value this parser does not understand is an error, not a skip. A
 *      skipped pair would be reported as a pass, so an unsupported colour
 *      format would quietly shrink the suite instead of failing it.
 *
 * Everything returns a result object rather than throwing, so the caller can
 * attach its own context (which token, which theme) to the failure.
 */

/** The three named colours that actually turn up in token files. */
const NAMED = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
};

/** Formats deliberately not supported in v1, named so the error is useful. */
const KNOWN_UNSUPPORTED = ['lab', 'lch', 'oklab', 'oklch', 'color-mix', 'color'];

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;

const ok = (rgba) => ({ ok: true, rgba });
const err = (reason) => ({ ok: false, reason });

/** A channel token to 0-255, or null if it is not a number. */
function channel(token) {
  if (!NUMBER.test(token)) return null;
  const n = parseFloat(token);
  return token.endsWith('%') ? (n / 100) * 255 : n;
}

/** An alpha token to 0-1, or null if it is not a number. */
function alpha(token) {
  if (!NUMBER.test(token)) return null;
  const n = parseFloat(token);
  return token.endsWith('%') ? n / 100 : n;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const TURNS = { deg: 1 / 360, grad: 1 / 400, rad: 1 / (2 * Math.PI), turn: 1 };

/** A hue token to a fraction of a turn, or null. A bare number is degrees. */
function hue(token) {
  const m = token.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/);
  if (!m) return null;
  const turns = parseFloat(m[1]) * TURNS[m[2] ?? 'deg'];
  // Wrap into [0, 1). Hue is an angle, so 480deg and -240deg are both 120deg.
  return ((turns % 1) + 1) % 1;
}

/** A percentage token to 0-1, or null. */
function percent(token) {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(token)) return null;
  return parseFloat(token) / 100;
}

/** HSL to sRGB. h in turns, s and l in 0-1. */
function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * HWB to sRGB. h in turns, w and b in 0-1.
 *
 * When whiteness and blackness sum to 1 or more the hue drops out entirely and
 * the result is the grey at w / (w + b). Missing that case is the usual bug,
 * because every other input hides it.
 */
function hwbToRgb(h, w, b) {
  if (w + b >= 1) {
    const grey = (w / (w + b)) * 255;
    return [grey, grey, grey];
  }
  return hslToRgb(h, 1, 0.5).map((c) => (c / 255) * (1 - w - b) * 255 + w * 255);
}

/**
 * Parse a CSS colour into [r, g, b, a] with r/g/b in 0-255 and a in 0-1.
 *
 * Supported: #rgb, #rgba, #rrggbb, #rrggbbaa; rgb(), rgba(), hsl(), hsla()
 * and hwb(), each in both the legacy comma syntax and the modern space syntax
 * with a slash alpha; and the three named colours above. Anything else fails
 * loudly.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return err('not a string');
  const text = input.trim();
  if (!text) return err('empty value');

  const named = NAMED[text.toLowerCase()];
  if (named) return ok([...named]);

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return err(`"${text}" is not a valid hex colour`);
    const wide = hex.length === 6 || hex.length === 8;
    const short = hex.length === 3 || hex.length === 4;
    if (!wide && !short) return err(`"${text}" is not a 3, 4, 6 or 8 digit hex colour`);
    const size = wide ? 2 : 1;
    const at = (i) => {
      const part = hex.slice(i * size, i * size + size);
      return parseInt(short ? part + part : part, 16);
    };
    const hasAlpha = hex.length === 4 || hex.length === 8;
    return ok([at(0), at(1), at(2), hasAlpha ? at(3) / 255 : 1]);
  }

  const fn = text.match(/^([a-zA-Z-]+)\s*\(([\s\S]*)\)$/);
  if (fn) {
    const name = fn[1].toLowerCase();
    const polar = name === 'hsl' || name === 'hsla' || name === 'hwb';
    if (polar) {
      // Same two syntaxes as rgb(): comma separated, or space separated with a
      // slash alpha. Split on the slash first so a modern alpha is never read
      // as a fourth component.
      const [head, ...tail] = fn[2].split('/');
      if (tail.length > 1) return err(`"${text}" has more than one slash`);
      const parts = head.trim().split(/[,\s]+/).filter(Boolean);
      const alphaToken = tail.length ? tail[0].trim() : parts[3];
      if (parts.length < 3) return err(`"${text}" needs a hue and two components`);
      if (tail.length === 0 && parts.length > 4) return err(`"${text}" has too many components`);
      if (tail.length === 1 && parts.length !== 3) return err(`"${text}" has too many components`);

      const h = hue(parts[0]);
      if (h === null) return err(`"${text}" has a hue that is not an angle`);
      // hsl() allows bare numbers for s and l in the modern syntax; hwb()
      // requires percentages, but accepting a bare number there costs nothing
      // and refusing it would only ever reject something a browser renders.
      const one = percent(parts[1]) ?? (NUMBER.test(parts[1]) ? parseFloat(parts[1]) / 100 : null);
      const two = percent(parts[2]) ?? (NUMBER.test(parts[2]) ? parseFloat(parts[2]) / 100 : null);
      if (one === null || two === null) return err(`"${text}" has a component that is not a number`);

      let a = 1;
      if (alphaToken !== undefined) {
        const parsed = alpha(alphaToken);
        if (parsed === null) return err(`"${text}" has an alpha that is not a number`);
        a = parsed;
      }
      const rgb =
        name === 'hwb'
          ? hwbToRgb(h, clamp(one, 0, 1), clamp(two, 0, 1))
          : hslToRgb(h, clamp(one, 0, 1), clamp(two, 0, 1));
      return ok([...rgb.map((c) => clamp(c, 0, 255)), clamp(a, 0, 1)]);
    }
    if (name !== 'rgb' && name !== 'rgba') {
      const hint = KNOWN_UNSUPPORTED.includes(name)
        ? `${name}() is not supported in v1. Convert the token to hex or rgb(), or open an issue.`
        : `${name}() is not a colour function this tool understands`;
      return err(`"${text}": ${hint}`);
    }
    // Both syntaxes at once: `rgb(1, 2, 3, .5)` and `rgb(1 2 3 / .5)`. Split on
    // the slash first so a modern alpha is never mistaken for a fourth channel.
    const [head, ...tail] = fn[2].split('/');
    if (tail.length > 1) return err(`"${text}" has more than one slash`);
    const parts = head.trim().split(/[,\s]+/).filter(Boolean);
    const alphaToken = tail.length ? tail[0].trim() : parts[3];
    if (parts.length < 3) return err(`"${text}" needs three colour channels`);
    if (tail.length === 0 && parts.length > 4) return err(`"${text}" has too many channels`);
    if (tail.length === 1 && parts.length !== 3) return err(`"${text}" has too many channels`);
    const rgb = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
    if (rgb.some((c) => c === null)) return err(`"${text}" has a channel that is not a number`);
    let a = 1;
    if (alphaToken !== undefined) {
      const parsed = alpha(alphaToken);
      if (parsed === null) return err(`"${text}" has an alpha that is not a number`);
      a = parsed;
    }
    return ok([...rgb.map((c) => clamp(c, 0, 255)), clamp(a, 0, 1)]);
  }

  if (text.includes('var(')) {
    return err(`"${text}" still contains var(). The token it points at was not found.`);
  }
  return err(`"${text}" is not a colour this tool can parse`);
}

/** Composite a translucent foreground over an opaque ground. */
export function composite(fg, bg) {
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]);
}

/** Relative luminance, per WCAG 2.x. */
export function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The contrast ratio of a foreground against an opaque ground, with the
 * foreground composited over that ground first.
 */
export function contrastRatio(fg, bg) {
  const over = composite(fg, bg);
  const [hi, lo] = [luminance(over), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

export const isOpaque = (rgba) => rgba[3] > 0.999;
