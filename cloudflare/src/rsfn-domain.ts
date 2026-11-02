import { sha256Hex } from './security.ts';
import { HttpError } from './http.ts';
import { isValidCNPJ, isValidCPF, onlyDigits } from './validation.ts';

type Cents = number;

function documentKind(input: string): 'PF' | 'PJ' | null {
  const digits = onlyDigits(input);
  if (digits.length === 11) return isValidCPF(digits) ? 'PF' : null;
  if (digits.length === 14) return isValidCNPJ(digits) ? 'PJ' : null;
  return null;
}

/**
 * Subconjunto do PAG0004 (RSFN/BCB) usado para transferências interbancárias.
 * O XML transmitido de verdade usa o XSD oficial do BCB; aqui o contrato é
 * fechado, sem DTD, sem entidades externas e sem atributos além do namespace.
 */
export const RSFN_NAMESPACE = 'http://bcb.gov.br';
export const PAG0004 = 'PAG0004';
export const FINALIDADE_TRANSFERENCIA = '0001';
export const RSFN_MAX_CENTS = 100_000_000;
export const RSFN_ISPB_PATTERN = /^\d{8}$/;
export const NUM_CTRL_IF_PATTERN = /^[A-Z]\d{8}\d{8}\d{6}\d{3}$/;
export const MAX_NOME_RSFN = 80;

export interface Pag0004Message {
  numCtrlIf: string;
  codMsg: string;
  ispbEmissor: string;
  ispbDestinatario: string;
  dtMovto: string;
  codCliEmissor: string;
  documentoEmissor: string;
  nomeEmissor: string;
  agenciaDestinatario: string;
  contaDestinatario: string;
  documentoDestinatario: string;
  nomeDestinatario: string;
  valorCents: Cents;
  finalidadeTransacao: string;
}

export interface RsfnIssue {
  field: string;
  code: string;
  message: string;
}

export interface Pag0004ParseResult {
  valid: boolean;
  issues: RsfnIssue[];
  message?: Pag0004Message;
  sha256: string;
}

const BC_FIELDS = new Set(['CodMsg', 'NumCtrlIF', 'ISPBEmissor', 'ISPBDestinatario', 'DtMovto']);
const PAY_FIELDS = new Set([
  'CodCliEmissor',
  'CNPJ_CPFEmissor',
  'NomCliEmissor',
  'ContaDestinatario',
  'AgenciaDestinatario',
  'CNPJ_CPFDestinatario',
  'NomCliDestinatario',
  'VlrLanc',
  'FinalidadeTransacao',
]);

function fieldError(field: string, code: string, message: string): RsfnIssue {
  return { field, code, message };
}

export function xmlEscape(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** NumCtrlIF = E + ISPB (8) + AAAAMMDD (8) + HHMMSS (6) + sequencial (3). */
export function buildNumCtrlIf(ispb: string, now: number, sequence: number): string {
  const date = new Date(now);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `E${ispb}${stamp}${pad(sequence % 1000, 3)}`;
}

export function valueToDecimal(cents: Cents): string {
  if (!Number.isSafeInteger(cents)) throw new HttpError(422, 'RSFN_INVALID', 'Valor monetário inválido.');
  return (cents / 100).toFixed(2);
}

export function validatePag0004(message: Pag0004Message): RsfnIssue[] {
  const issues: RsfnIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push(fieldError(field, code, detail));
  };

  if (message.codMsg !== PAG0004) add('CodMsg', 'COD_MSG', 'CodMsg deve ser PAG0004.');
  if (!RSFN_ISPB_PATTERN.test(message.ispbEmissor)) {
    add('ISPBEmissor', 'ISPB', 'ISPB do emissor deve ter exatamente 8 dígitos.');
  }
  if (!RSFN_ISPB_PATTERN.test(message.ispbDestinatario)) {
    add('ISPBDestinatario', 'ISPB', 'ISPB do destinatário deve ter exatamente 8 dígitos.');
  }
  if (
    RSFN_ISPB_PATTERN.test(message.ispbEmissor) &&
    RSFN_ISPB_PATTERN.test(message.ispbDestinatario) &&
    message.ispbEmissor === message.ispbDestinatario
  ) {
    add('ISPBDestinatario', 'ISPB_IGUAL', 'Emissor e destinatário não podem ser a mesma instituição.');
  }

  if (!NUM_CTRL_IF_PATTERN.test(message.numCtrlIf)) {
    add('NumCtrlIF', 'NUM_CTRL', 'NumCtrlIF deve ter 26 caracteres: E + ISPB + data + hora + sequencial.');
  } else {
    if (message.numCtrlIf.slice(1, 9) !== message.ispbEmissor) {
      add('NumCtrlIF', 'NUM_CTRL_ISPB', 'NumCtrlIF não corresponde ao ISPB emissor.');
    }
    if (message.numCtrlIf.slice(9, 17) !== message.dtMovto.replace(/\D/g, '')) {
      add('NumCtrlIF', 'NUM_CTRL_DATA', 'NumCtrlIF não corresponde à data de movimento.');
    }
  }

  if (!isIsoDate(message.dtMovto)) add('DtMovto', 'DATA', 'DtMovto deve ser uma data válida no formato AAAA-MM-DD.');

  if (!/^\d{1,8}$/.test(message.codCliEmissor)) {
    add('CodCliEmissor', 'COD_CLI', 'CodCliEmissor deve ter de 1 a 8 dígitos.');
  }
  if (documentKind(message.documentoEmissor) === null) {
    add('CNPJ_CPFEmissor', 'DOCUMENTO', 'CPF/CNPJ do emissor inválido.');
  }
  if (
    message.nomeEmissor.trim().length === 0 ||
    message.nomeEmissor.trim().length > MAX_NOME_RSFN ||
    hasControlChars(message.nomeEmissor)
  ) {
    add('NomCliEmissor', 'NOME', `Nome do emissor deve ter 1 a ${MAX_NOME_RSFN} caracteres.`);
  }

  if (!/^\d{1,6}$/.test(message.agenciaDestinatario)) {
    add('AgenciaDestinatario', 'AGENCIA', 'Agência do destinatário deve ter de 1 a 6 dígitos.');
  }
  if (!/^\d{1,12}$/.test(message.contaDestinatario)) {
    add('ContaDestinatario', 'CONTA', 'Conta do destinatário deve ter de 1 a 12 dígitos.');
  }
  if (documentKind(message.documentoDestinatario) === null) {
    add('CNPJ_CPFDestinatario', 'DOCUMENTO', 'CPF/CNPJ do destinatário inválido.');
  }
  if (
    message.nomeDestinatario.trim().length === 0 ||
    message.nomeDestinatario.trim().length > MAX_NOME_RSFN ||
    hasControlChars(message.nomeDestinatario)
  ) {
    add('NomCliDestinatario', 'NOME', `Nome do destinatário deve ter 1 a ${MAX_NOME_RSFN} caracteres.`);
  }

  if (!Number.isSafeInteger(message.valorCents) || message.valorCents <= 0) {
    add('VlrLanc', 'VALOR', 'VlrLanc deve ser maior que zero.');
  } else if (message.valorCents > RSFN_MAX_CENTS) {
    add('VlrLanc', 'VALOR_LIMITE', 'VlrLanc excede o limite de R$ 1.000.000,00 por mensagem.');
  }
  if (message.finalidadeTransacao !== FINALIDADE_TRANSFERENCIA) {
    add('FinalidadeTransacao', 'FINALIDADE', 'FinalidadeTransacao suportada: 0001 (transferência).');
  }
  return issues;
}

export function assertPag0004(message: Pag0004Message): Pag0004Message {
  const issues = validatePag0004(message);
  if (issues.length) {
    throw new HttpError(422, 'RSFN_INVALID', issues[0].message, { issues });
  }
  return message;
}

export function buildPag0004Xml(message: Pag0004Message): string {
  assertPag0004(message);
  const e = xmlEscape;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<DOC xmlns="${RSFN_NAMESPACE}">`,
    '  <BC>',
    `    <CodMsg>${PAG0004}</CodMsg>`,
    `    <NumCtrlIF>${e(message.numCtrlIf)}</NumCtrlIF>`,
    `    <ISPBEmissor>${e(message.ispbEmissor)}</ISPBEmissor>`,
    `    <ISPBDestinatario>${e(message.ispbDestinatario)}</ISPBDestinatario>`,
    `    <DtMovto>${e(message.dtMovto)}</DtMovto>`,
    '  </BC>',
    '  <SIS>',
    `    <${PAG0004}>`,
    `      <CodCliEmissor>${e(message.codCliEmissor)}</CodCliEmissor>`,
    `      <CNPJ_CPFEmissor>${e(message.documentoEmissor)}</CNPJ_CPFEmissor>`,
    `      <NomCliEmissor>${e(message.nomeEmissor)}</NomCliEmissor>`,
    `      <ContaDestinatario>${e(message.contaDestinatario)}</ContaDestinatario>`,
    `      <AgenciaDestinatario>${e(message.agenciaDestinatario)}</AgenciaDestinatario>`,
    `      <CNPJ_CPFDestinatario>${e(message.documentoDestinatario)}</CNPJ_CPFDestinatario>`,
    `      <NomCliDestinatario>${e(message.nomeDestinatario)}</NomCliDestinatario>`,
    `      <VlrLanc>${valueToDecimal(message.valorCents)}</VlrLanc>`,
    `      <FinalidadeTransacao>${e(message.finalidadeTransacao)}</FinalidadeTransacao>`,
    `    </${PAG0004}>`,
    '  </SIS>',
    '</DOC>',
    '',
  ].join('\n');
}

interface XmlToken {
  kind: 'open' | 'close' | 'text';
  name?: string;
  attrs?: string;
  value?: string;
}

function tokenize(xml: string): { tokens: XmlToken[]; issue?: RsfnIssue } {
  const tokens: XmlToken[] = [];
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) {
      tokens.push({ kind: 'text', value: xml.slice(index) });
      break;
    }
    if (lt > index) tokens.push({ kind: 'text', value: xml.slice(index, lt) });
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) {
      return { tokens, issue: fieldError('XML', 'XML_MALFORMADO', 'Tag sem fechamento ">".') };
    }
    const raw = xml.slice(lt + 1, gt).trim();
    if (!raw) return { tokens, issue: fieldError('XML', 'XML_MALFORMADO', 'Tag vazia.') };
    if (raw.startsWith('!') || raw.startsWith('?')) {
      return {
        tokens,
        issue: fieldError('XML', 'XML_PROIBIDO', 'DTD, CDATA, comentários e instruções de processamento são proibidos.'),
      };
    }
    if (raw.startsWith('/')) {
      tokens.push({ kind: 'close', name: raw.slice(1).trim() });
    } else {
      if (raw.endsWith('/')) {
        return { tokens, issue: fieldError('XML', 'XML_MALFORMADO', 'Elementos vazios não são aceitos neste contrato.') };
      }
      const match = /^([A-Za-z][A-Za-z0-9_]*)([\s\S]*)$/.exec(raw);
      if (!match) return { tokens, issue: fieldError('XML', 'XML_MALFORMADO', 'Nome de elemento inválido.') };
      tokens.push({ kind: 'open', name: match[1], attrs: match[2].trim() });
    }
    index = gt + 1;
  }
  return { tokens };
}

function decodeText(raw: string): { value?: string; issue?: RsfnIssue } {
  if (/[<>&]/.test(raw.replace(/&(?:amp|lt|gt|quot|apos);/g, ''))) {
    return { issue: fieldError('XML', 'XML_ENTIDADE', 'Entidade XML não reconhecida ou caractere inválido.') };
  }
  const value = raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  if (hasControlChars(value)) {
    return { issue: fieldError('XML', 'XML_CARACTERE', 'Texto contém caracteres de controle.') };
  }
  return { value };
}

export async function parsePag0004Xml(xml: string): Promise<Pag0004ParseResult> {
  const sha256 = await sha256Hex(String(xml ?? ''));
  const source = String(xml ?? '').replace(/^\uFEFF/, '').trim();
  const issues: RsfnIssue[] = [];
  if (!source) {
    return { valid: false, issues: [fieldError('XML', 'XML_VAZIO', 'XML vazio.')], sha256 };
  }

  const declarations = source.match(/<\?/g)?.length ?? 0;
  if (declarations > 1 || (declarations === 1 && !/^<\?xml\s[^?]*\?>/.test(source))) {
    return {
      valid: false,
      issues: [fieldError('XML', 'XML_PROIBIDO', 'Apenas a declaração XML padrão é permitida.')],
      sha256,
    };
  }
  if (source.includes('<!')) {
    return {
      valid: false,
      issues: [fieldError('XML', 'XML_PROIBIDO', 'DTD, CDATA e comentários são proibidos.')],
      sha256,
    };
  }
  const body = source.replace(/^<\?xml\s[^?]*\?>\s*/, '');
  if (!body.startsWith('<DOC')) {
    return { valid: false, issues: [fieldError('XML', 'XML_RAIZ', 'Raiz DOC não encontrada.')], sha256 };
  }

  const { tokens, issue } = tokenize(body);
  if (issue) return { valid: false, issues: [issue], sha256 };

  const allowed = new Set(['DOC', 'BC', 'SIS', PAG0004, ...BC_FIELDS, ...PAY_FIELDS]);
  const stack: string[] = [];
  const textByField = new Map<string, string>();
  const seenFields = new Set<string>();
  const structuralParent: Record<string, string | null> = { DOC: null, BC: 'DOC', SIS: 'DOC', [PAG0004]: 'SIS' };
  let rootOpened = false;
  let rootClosed = false;

  for (const token of tokens) {
    if (token.kind === 'text') {
      const value = token.value ?? '';
      if (!value.trim()) continue;
      if (rootClosed) {
        issues.push(fieldError('XML', 'XML_TEXTO', 'Conteúdo após o fechamento de DOC.'));
        continue;
      }
      const parent = stack[stack.length - 1];
      if (!parent || !(BC_FIELDS.has(parent) || PAY_FIELDS.has(parent))) {
        issues.push(fieldError('XML', 'XML_TEXTO', 'Texto fora de um campo permitido.'));
        continue;
      }
      const decoded = decodeText(value);
      if (decoded.issue) {
        issues.push(decoded.issue);
        continue;
      }
      textByField.set(parent, (textByField.get(parent) ?? '') + (decoded.value ?? ''));
      continue;
    }

    const name = token.name ?? '';
    if (token.kind === 'open') {
      if (rootClosed) {
        issues.push(fieldError('XML', 'XML_ESTRUTURA', 'Elemento após o fechamento de DOC.'));
        continue;
      }
      if (!allowed.has(name)) {
        issues.push(fieldError('XML', 'XML_ELEMENTO', `Elemento não permitido: ${name}.`));
        continue;
      }
      if (!rootOpened) {
        if (name !== 'DOC') {
          issues.push(fieldError('XML', 'XML_RAIZ', 'O primeiro elemento deve ser DOC.'));
          continue;
        }
        if (token.attrs !== `xmlns="${RSFN_NAMESPACE}"`) {
          issues.push(fieldError('DOC', 'XML_NAMESPACE', `DOC deve declarar xmlns="${RSFN_NAMESPACE}".`));
        }
        rootOpened = true;
      } else if (token.attrs) {
        issues.push(fieldError(name, 'XML_ATRIBUTO', `Atributos não são permitidos em ${name}.`));
      }

      const parent = stack[stack.length - 1] ?? null;
      if (BC_FIELDS.has(name) || PAY_FIELDS.has(name)) {
        const expectedParent = BC_FIELDS.has(name) ? 'BC' : PAG0004;
        if (parent !== expectedParent) {
          issues.push(fieldError(name, 'XML_ESTRUTURA', `${name} deve ficar dentro de ${expectedParent}.`));
        }
        if (seenFields.has(name)) {
          issues.push(fieldError(name, 'XML_DUPLICADO', `Campo ${name} repetido.`));
        }
        seenFields.add(name);
      } else if (structuralParent[name] !== parent) {
        issues.push(fieldError(name, 'XML_ESTRUTURA', `${name} está fora do elemento pai esperado.`));
      }
      stack.push(name);
      continue;
    }

    const expected = stack[stack.length - 1];
    if (expected !== name) {
      issues.push(fieldError('XML', 'XML_ESTRUTURA', `Fechamento inesperado de ${name}.`));
      continue;
    }
    stack.pop();
    if (name === 'DOC') rootClosed = true;
  }

  if (stack.length) {
    issues.push(fieldError('XML', 'XML_ESTRUTURA', `Elemento não fechado: ${stack[stack.length - 1]}.`));
  }
  if (!rootOpened || !rootClosed) {
    issues.push(fieldError('XML', 'XML_ESTRUTURA', 'DOC deve ser aberto e fechado.'));
  }

  const get = (field: string): string => (textByField.get(field) ?? '').trim();
  const valorRaw = get('VlrLanc');
  let valorCents = 0;
  if (!/^\d{1,12}\.\d{2}$/.test(valorRaw)) {
    issues.push(fieldError('VlrLanc', 'VALOR_FORMATO', 'VlrLanc deve estar no formato decimal com duas casas (ex.: 1500.00).'));
  } else {
    const [whole, fraction] = valorRaw.split('.');
    valorCents = Number(whole) * 100 + Number(fraction);
  }

  const message: Pag0004Message = {
    numCtrlIf: get('NumCtrlIF'),
    codMsg: get('CodMsg'),
    ispbEmissor: get('ISPBEmissor'),
    ispbDestinatario: get('ISPBDestinatario'),
    dtMovto: get('DtMovto'),
    codCliEmissor: get('CodCliEmissor'),
    documentoEmissor: get('CNPJ_CPFEmissor'),
    nomeEmissor: get('NomCliEmissor'),
    agenciaDestinatario: get('AgenciaDestinatario'),
    contaDestinatario: get('ContaDestinatario'),
    documentoDestinatario: get('CNPJ_CPFDestinatario'),
    nomeDestinatario: get('NomCliDestinatario'),
    valorCents,
    finalidadeTransacao: get('FinalidadeTransacao'),
  };

  for (const required of [...BC_FIELDS, ...PAY_FIELDS]) {
    if (!seenFields.has(required) && required !== 'VlrLanc') {
      issues.push(fieldError(required, 'XML_OBRIGATORIO', `Campo obrigatório ausente: ${required}.`));
    }
  }
  issues.push(...validatePag0004(message));

  return { valid: issues.length === 0, issues, message, sha256 };
}
