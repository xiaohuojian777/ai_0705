type MatrixInput = string | ArrayLike<number> | undefined;

class DOMPointPolyfill {
  x: number;
  y: number;
  z: number;
  w: number;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  matrixTransform(matrix: DOMMatrixPolyfill) {
    return matrix.transformPoint(this);
  }
}

class DOMRectPolyfill {
  x: number;
  y: number;
  width: number;
  height: number;

  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}

function multiplyMatrices(left: number[], right: number[]) {
  const output = new Array<number>(16).fill(0);

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let total = 0;

      for (let index = 0; index < 4; index += 1) {
        total += left[row * 4 + index] * right[index * 4 + column];
      }

      output[row * 4 + column] = total;
    }
  }

  return output;
}

function parseMatrixString(input: string) {
  if (input.startsWith("matrix3d(")) {
    return input
      .slice("matrix3d(".length, -1)
      .split(",")
      .map((value) => Number.parseFloat(value.trim()));
  }

  if (input.startsWith("matrix(")) {
    const values = input
      .slice("matrix(".length, -1)
      .split(",")
      .map((value) => Number.parseFloat(value.trim()));

    return [
      values[0] ?? 1,
      values[1] ?? 0,
      0,
      0,
      values[2] ?? 0,
      values[3] ?? 1,
      0,
      0,
      0,
      0,
      1,
      0,
      values[4] ?? 0,
      values[5] ?? 0,
      0,
      1,
    ];
  }

  return undefined;
}

class DOMMatrixPolyfill {
  private values: number[];
  is2D: boolean;

  constructor(init?: MatrixInput) {
    this.values = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    this.is2D = true;

    if (typeof init === "string") {
      init = parseMatrixString(init);
    }

    if (!init) {
      return;
    }

    const values = Array.from(init);

    if (values.length === 6) {
      this.values = [
        values[0] ?? 1,
        values[1] ?? 0,
        0,
        0,
        values[2] ?? 0,
        values[3] ?? 1,
        0,
        0,
        0,
        0,
        1,
        0,
        values[4] ?? 0,
        values[5] ?? 0,
        0,
        1,
      ];
      return;
    }

    if (values.length === 16) {
      this.values = values;
      this.is2D = !(
        values[2] || values[3] || values[6] || values[7] || values[8] || values[9] ||
        values[11] || values[14] || values[10] !== 1 || values[15] !== 1
      );
    }
  }

  get a() { return this.values[0]; }
  set a(value: number) { this.values[0] = value; }
  get b() { return this.values[1]; }
  set b(value: number) { this.values[1] = value; }
  get c() { return this.values[4]; }
  set c(value: number) { this.values[4] = value; }
  get d() { return this.values[5]; }
  set d(value: number) { this.values[5] = value; }
  get e() { return this.values[12]; }
  set e(value: number) { this.values[12] = value; }
  get f() { return this.values[13]; }
  set f(value: number) { this.values[13] = value; }

  get m11() { return this.values[0]; }
  set m11(value: number) { this.values[0] = value; }
  get m12() { return this.values[1]; }
  set m12(value: number) { this.values[1] = value; }
  get m13() { return this.values[2]; }
  set m13(value: number) { this.values[2] = value; this.is2D = false; }
  get m14() { return this.values[3]; }
  set m14(value: number) { this.values[3] = value; this.is2D = false; }
  get m21() { return this.values[4]; }
  set m21(value: number) { this.values[4] = value; }
  get m22() { return this.values[5]; }
  set m22(value: number) { this.values[5] = value; }
  get m23() { return this.values[6]; }
  set m23(value: number) { this.values[6] = value; this.is2D = false; }
  get m24() { return this.values[7]; }
  set m24(value: number) { this.values[7] = value; this.is2D = false; }
  get m31() { return this.values[8]; }
  set m31(value: number) { this.values[8] = value; this.is2D = false; }
  get m32() { return this.values[9]; }
  set m32(value: number) { this.values[9] = value; this.is2D = false; }
  get m33() { return this.values[10]; }
  set m33(value: number) { this.values[10] = value; this.is2D = false; }
  get m34() { return this.values[11]; }
  set m34(value: number) { this.values[11] = value; this.is2D = false; }
  get m41() { return this.values[12]; }
  set m41(value: number) { this.values[12] = value; }
  get m42() { return this.values[13]; }
  set m42(value: number) { this.values[13] = value; }
  get m43() { return this.values[14]; }
  set m43(value: number) { this.values[14] = value; this.is2D = false; }
  get m44() { return this.values[15]; }
  set m44(value: number) { this.values[15] = value; this.is2D = false; }

  multiplySelf(other: DOMMatrixPolyfill) {
    this.values = multiplyMatrices(other.values, this.values);
    this.is2D = this.is2D && other.is2D;
    return this;
  }

  preMultiplySelf(other: DOMMatrixPolyfill) {
    this.values = multiplyMatrices(this.values, other.values);
    this.is2D = this.is2D && other.is2D;
    return this;
  }

  translateSelf(tx = 0, ty = 0, tz = 0) {
    this.values = multiplyMatrices([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      tx, ty, tz, 1,
    ], this.values);
    if (tz !== 0) {
      this.is2D = false;
    }
    return this;
  }

  scaleSelf(scaleX = 1, scaleY = scaleX, scaleZ = 1, originX = 0, originY = 0, originZ = 0) {
    this.translateSelf(originX, originY, originZ);
    this.values = multiplyMatrices([
      scaleX, 0, 0, 0,
      0, scaleY, 0, 0,
      0, 0, scaleZ, 0,
      0, 0, 0, 1,
    ], this.values);
    this.translateSelf(-originX, -originY, -originZ);
    if (scaleZ !== 1 || originZ !== 0) {
      this.is2D = false;
    }
    return this;
  }

  rotateSelf(rotX = 0, rotY?: number, rotZ?: number) {
    if (rotY === undefined && rotZ === undefined) {
      rotZ = rotX;
      rotX = 0;
      rotY = 0;
    }

    const radians = ((rotZ ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    this.values = multiplyMatrices([
      cos, sin, 0, 0,
      -sin, cos, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ], this.values);

    if ((rotX ?? 0) !== 0 || (rotY ?? 0) !== 0) {
      this.is2D = false;
    }

    return this;
  }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;

    if (determinant === 0) {
      this.values = new Array<number>(16).fill(Number.NaN);
      this.is2D = false;
      return this;
    }

    const nextA = this.d / determinant;
    const nextB = -this.b / determinant;
    const nextC = -this.c / determinant;
    const nextD = this.a / determinant;
    const nextE = (this.c * this.f - this.d * this.e) / determinant;
    const nextF = (this.b * this.e - this.a * this.f) / determinant;

    this.values = [
      nextA, nextB, 0, 0,
      nextC, nextD, 0, 0,
      0, 0, 1, 0,
      nextE, nextF, 0, 1,
    ];

    return this;
  }

  transformPoint(point: { x?: number; y?: number; z?: number; w?: number }) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    const z = point.z ?? 0;
    const w = point.w ?? 1;

    return new DOMPointPolyfill(
      this.values[0] * x + this.values[4] * y + this.values[8] * z + this.values[12] * w,
      this.values[1] * x + this.values[5] * y + this.values[9] * z + this.values[13] * w,
      this.values[2] * x + this.values[6] * y + this.values[10] * z + this.values[14] * w,
      this.values[3] * x + this.values[7] * y + this.values[11] * z + this.values[15] * w,
    );
  }

  toFloat32Array() {
    return Float32Array.from(this.values);
  }

  toFloat64Array() {
    return Float64Array.from(this.values);
  }
}

class ImageDataPolyfill {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(dataOrWidth: Uint8ClampedArray | number, width?: number, height?: number) {
    if (typeof dataOrWidth === "number") {
      this.width = dataOrWidth;
      this.height = width ?? 0;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }

    this.data = dataOrWidth;
    this.width = width ?? 0;
    this.height = height ?? 0;
  }
}

class Path2DPolyfill {
  addPath() {}
}

export function ensurePdfRuntimePolyfills() {
  const runtime = globalThis as Record<string, unknown>;

  runtime.DOMMatrix ??= DOMMatrixPolyfill;
  runtime.DOMPoint ??= DOMPointPolyfill;
  runtime.DOMRect ??= DOMRectPolyfill;
  runtime.ImageData ??= ImageDataPolyfill;
  runtime.Path2D ??= Path2DPolyfill;
}
