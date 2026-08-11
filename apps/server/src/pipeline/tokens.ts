/** Special chat-control tokens, built from char codes so the source stays
 * free of literal control sequences. */
const c = (...codes: number[]): string => String.fromCharCode(...codes);

export const IM_START = c(60, 124, 105, 109, 95, 115, 116, 97, 114, 116, 124, 62);
export const IM_END = c(60, 124, 105, 109, 95, 101, 110, 100, 124, 62);
export const LLAMA_START = c(
  60,
  124,
  115,
  116,
  97,
  114,
  116,
  95,
  104,
  101,
  97,
  100,
  101,
  114,
  124,
  62,
);
export const LLAMA_END = c(60, 124, 101, 111, 116, 95, 105, 100, 124, 62);
