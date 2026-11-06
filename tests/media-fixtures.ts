export const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><path fill="red" d="M0 0H32V16H0Z"/></svg>',
);
export function gifFixture(transparent = true) {
  const out: number[] = [
    ...Buffer.from("GIF89a"),
    2,
    0,
    1,
    0,
    0x81,
    0,
    0,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
  ];
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  function frame(
    left: number,
    indices: number[],
    disposal: number,
    delay: number,
  ) {
    out.push(
      0x21,
      0xf9,
      4,
      (disposal << 2) | (transparent ? 1 : 0),
      delay,
      0,
      0,
      0,
      0x2c,
      left,
      0,
      0,
      0,
      indices.length,
      0,
      1,
      0,
      0,
      2,
    );
    let bits = 0,
      n = 0;
    const data: number[] = [];
    for (const code of indices.flatMap((i) => [4, i]).concat(5)) {
      bits |= code << n;
      n += 3;
      while (n >= 8) {
        data.push(bits & 255);
        bits >>= 8;
        n -= 8;
      }
    }
    if (n) data.push(bits & 255);
    out.push(data.length, ...data, 0);
  }
  frame(0, [1, 1], 1, 10);
  frame(0, [2], 3, 20);
  frame(1, [3], 2, 30);
  frame(0, [0], 1, 40);
  out.push(0x3b);
  return Buffer.from(out);
}
