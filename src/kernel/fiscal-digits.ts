const CROCKFORD = '0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

/** Módulo 11 (pesos 2..9 da direita para a esquerda), padrão da chave de acesso da NF-e. */
export function mod11CheckDigit(digits: string): number {
  let weight = 2;
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Gera 8 dígitos pseudoaleatórios determinísticos para o cNF (código numérico). */
export function numericCodeFrom(seed: string): string {
  const bytes = Buffer.from(seed).toString('hex');
  let value = 0n;
  for (let index = 0; index < 16; index += 1) {
    value = (value * 31n + BigInt(parseInt(bytes[index] ?? '0', 16))) % 100_000_000n;
  }
  return value.toString().padStart(8, '0');
}

export function isCro(value: string): boolean {
  return [...value].every((char) => CROCKFORD.includes(char));
}
