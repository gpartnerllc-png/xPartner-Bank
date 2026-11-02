import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import { sha1Hex, sha256Hex } from '../kernel/crypto.ts';
import { AppError } from '../kernel/errors.ts';
import { mod11CheckDigit, numericCodeFrom } from '../kernel/fiscal-digits.ts';
import { formatBRL } from '../kernel/money.ts';
import type { PaymentMethod } from './risk.ts';

export interface FiscalMerchantInfo {
  cnpj: string;
  legalName: string;
  tradeName: string;
  ie: string;
  city: string;
  uf: string;
  cMun: string;
  crt: '1' | '2' | '3';
}

export interface FiscalItem {
  code: string;
  name: string;
  ncm: string;
  cfop: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  totalCents: number;
}

export interface NfceInput {
  merchant: FiscalMerchantInfo;
  transactionId: string;
  nsu: string;
  authorizationCode?: string;
  method: PaymentMethod;
  amountCents: number;
  installments: number;
  items: FiscalItem[];
  serie: number;
  number: number;
  emittedAt: Date;
  ambiente: 'homologacao' | 'producao';
  contingency: boolean;
  keySeed: string;
}

export interface NfceResult {
  accessKey: string;
  xml: string;
  qrCodeUrl: string;
  danfeText: string;
  escpos: string;
}

const TPAG: Record<PaymentMethod, string> = {
  CREDIT: '03',
  DEBIT: '04',
  PIX: '17',
  VOUCHER: '10',
};

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CREDIT: 'Cartao de Credito',
  DEBIT: 'Cartao de Debito',
  PIX: 'Pix',
  VOUCHER: 'Voucher',
};

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function generateAccessKey(input: {
  cUF: string;
  emittedAt: Date;
  cnpj: string;
  serie: number;
  number: number;
  tpEmis: '1' | '9';
  cNF: string;
  model?: string;
}): string {
  const cnpj = onlyDigits(input.cnpj).padStart(14, '0').slice(0, 14);
  const year = String(input.emittedAt.getFullYear() % 100).padStart(2, '0');
  const month = String(input.emittedAt.getMonth() + 1).padStart(2, '0');
  const cNF = onlyDigits(input.cNF).padStart(8, '0').slice(0, 8);
  const base =
    input.cUF.padStart(2, '0') +
    year +
    month +
    cnpj +
    (input.model ?? '65').padStart(2, '0') +
    String(input.serie).padStart(3, '0') +
    String(input.number).padStart(9, '0') +
    input.tpEmis +
    cNF;
  if (base.length !== 43) throw new AppError('FISCAL_KEY_INVALID', 'Chave de acesso com tamanho inválido.', 500);
  return base + String(mod11CheckDigit(base));
}

function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function quantity(value: number): string {
  return value.toFixed(4);
}

export function buildQrCodeUrl(accessKey: string, ambiente: 'homologacao' | 'producao'): string {
  const tpAmb = ambiente === 'homologacao' ? '2' : '1';
  const host =
    ambiente === 'homologacao'
      ? 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode'
      : 'https://www.nfce.fazenda.sp.gov.br/qrcode';
  const token = sha1Hex(`XPARTNER${accessKey}`).slice(0, 8);
  const hash = sha1Hex(`${accessKey}|2|${ambiente}`).slice(0, 40);
  return `${host}?p=${accessKey}|2|${tpAmb}|${token}|${hash}`;
}

function buildXml(input: NfceInput, accessKey: string, qrCodeUrl: string, cUF: string): string {
  const emitted = input.emittedAt.toISOString().replace('Z', '-03:00');
  const tpAmb = input.ambiente === 'homologacao' ? '2' : '1';
  const tpEmis = input.contingency ? '9' : '1';
  const totalProducts = input.items.reduce((sum, item) => sum + item.totalCents, 0);
  const total = Math.max(totalProducts, input.amountCents);

  const items = input.items
    .map(
      (item, index) => `
      <det nItem="${index + 1}">
        <prod>
          <cProd>${esc(item.code)}</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>${esc(item.name)}</xProd>
          <NCM>${esc(item.ncm.replace(/\D/g, '').padStart(8, '0'))}</NCM>
          <CFOP>${esc(item.cfop)}</CFOP>
          <uCom>${esc(item.unit)}</uCom>
          <qCom>${quantity(item.quantity)}</qCom>
          <vUnCom>${(item.unitPriceCents / 100).toFixed(2)}</vUnCom>
          <vProd>${money(item.totalCents)}</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>${esc(item.unit)}</uTrib>
          <qTrib>${quantity(item.quantity)}</qTrib>
          <vUnTrib>${(item.unitPriceCents / 100).toFixed(2)}</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS>
            <ICMSSN102>
              <orig>0</orig>
              <CSOSN>102</CSOSN>
            </ICMSSN102>
          </ICMS>
          <PIS><PISOutr><CST>49</CST><vBC>0.00</vBC><vPIS>0.00</vPIS></PISOutr></PIS>
          <COFINS><COFINSOutr><CST>49</CST><vBC>0.00</vBC><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>
        </imposto>
      </det>`,
    )
    .join('');

  const cardBlock =
    input.method === 'CREDIT' || input.method === 'DEBIT'
      ? `<card><tpIntegra>1</tpIntegra><tBand>99</tBand><cAut>${esc(input.authorizationCode ?? '')}</cAut></card>`
      : '';

  const infCpl = [
    `NSU ${input.nsu}`,
    input.authorizationCode ? `AUT ${input.authorizationCode}` : '',
    `Transacao ${input.transactionId}`,
    `Pagamento vinculado automaticamente a NFC-e (Decreto de Integracao Fiscal).`,
    input.contingency ? 'EMITIDA EM CONTINGENCIA OFFLINE - TRANSMITIR A SEFAZ QUANDO HOUVER CONEXAO.' : '',
  ]
    .filter(Boolean)
    .join(' | ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${accessKey}" versao="4.00">
    <ide>
      <cUF>${esc(cUF)}</cUF>
      <cNF>${esc(accessKey.slice(35, 43))}</cNF>
      <natOp>Venda de Mercadoria</natOp>
      <mod>65</mod>
      <serie>${input.serie}</serie>
      <nNF>${input.number}</nNF>
      <dhEmi>${emitted}</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>${esc(input.merchant.cMun)}</cMunFG>
      <tpImp>4</tpImp>
      <tpEmis>${tpEmis}</tpEmis>
      <cDV>${accessKey.slice(-1)}</cDV>
      <tpAmb>${tpAmb}</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>1</indFinal>
      <indPres>1</indPres>
      <procEmi>0</procEmi>
      <verProc>XPARTNER-1.0</verProc>
    </ide>
    <emit>
      <CNPJ>${onlyDigits(input.merchant.cnpj)}</CNPJ>
      <xNome>${esc(input.merchant.legalName)}</xNome>
      <xFant>${esc(input.merchant.tradeName)}</xFant>
      <enderEmit>
        <xLgr>Rua XPARTNER</xLgr>
        <nro>100</nro>
        <xBairro>Centro</xBairro>
        <cMun>${esc(input.merchant.cMun)}</cMun>
        <xMun>${esc(input.merchant.city)}</xMun>
        <UF>${esc(input.merchant.uf)}</UF>
        <CEP>01001000</CEP>
        <cPais>1058</cPais>
        <xPais>BRASIL</xPais>
        <fone>1130000000</fone>
      </enderEmit>
      <IE>${esc(input.merchant.ie)}</IE>
      <CRT>${esc(input.merchant.crt)}</CRT>
    </emit>
    <dest><CPF>00000000000</CPF><xNome>CONSUMIDOR FINAL</xNome><indIEDest>9</indIEDest></dest>${items}
    <total>
      <ICMSTot>
        <vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>
        <vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST>
        <vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${money(totalProducts)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg>
        <vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>
        <vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${money(total)}</vNF>
      </ICMSTot>
    </total>
    <transp><modFrete>9</modFrete></transp>
    <pag>
      <detPag>
        <tPag>${TPAG[input.method]}</tPag>
        <vPag>${money(input.amountCents)}</vPag>${cardBlock}
      </detPag>
      ${input.installments > 1 ? `<vTroco>0.00</vTroco>` : ''}
    </pag>
    <infAdic><infCpl>${esc(infCpl)}</infCpl></infAdic>
  </infNFe>
  <infNFeSupl>
    <qrCode><![CDATA[${qrCodeUrl}]]></qrCode>
    <urlChave>${input.ambiente === 'homologacao' ? 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta' : 'https://www.nfce.fazenda.sp.gov.br/consulta'}</urlChave>
  </infNFeSupl>
</NFe>`;
}

const signingKeys = new Map<string, string>();

function signingKey(config: AppConfig): string {
  if (config.fiscalPrivateKeyPem) return config.fiscalPrivateKeyPem;
  const cached = signingKeys.get('dev');
  if (cached) return cached;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  signingKeys.set('dev', pem);
  return pem;
}

/**
 * Assinatura XMLDSig simplificada para desenvolvimento.
 * Em produção: XMLDSig completo com certificado A1 ICP-Brasil no HSM/KMS (ver docs/SEGURANCA.md).
 */
export function signNfceXml(xml: string, privateKeyPem: string, accessKey: string): string {
  const start = xml.indexOf('<infNFe');
  const end = xml.indexOf('</infNFe>') + '</infNFe>'.length;
  if (start < 0 || end < start) throw new AppError('FISCAL_SIGNATURE_FAILED', 'infNFe ausente no XML.', 500);
  const infNFe = xml.slice(start, end);
  const digest = createHash('sha1').update(infNFe).digest('base64');
  const signedInfo =
    `<SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
    `<Reference URI="#NFe${accessKey}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const signatureValue = createSign('RSA-SHA256').update(signedInfo).sign(privateKeyPem, 'base64');
  const signature =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfo}` +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><KeyName>XPARTNER-DEV</KeyName></KeyInfo></Signature>`;
  return xml.replace('</NFe>', `${signature}</NFe>`);
}

function stripAccents(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
}

function wrap(text: string, width = 42): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + (line ? ' ' : '') + word).length > width) {
      if (line) lines.push(line);
      line = word.slice(0, width);
    } else {
      line += (line ? ' ' : '') + word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function buildDanfeText(input: {
  merchant: FiscalMerchantInfo;
  accessKey: string;
  number: number;
  serie: number;
  emittedAt: Date;
  items: FiscalItem[];
  amountCents: number;
  method: PaymentMethod;
  installments: number;
  nsu: string;
  contingency: boolean;
  qrCodeUrl: string;
}): string {
  const sep = '-'.repeat(42);
  const lines: string[] = [];
  lines.push(sep, input.merchant.tradeName.slice(0, 42), input.merchant.legalName.slice(0, 42));
  lines.push(`CNPJ ${onlyDigits(input.merchant.cnpj)}  IE ${input.merchant.ie}`);
  lines.push(`${input.merchant.city}/${input.merchant.uf}`, sep);
  lines.push(`NFC-e No ${input.number}  Serie ${input.serie}  ${input.emittedAt.toLocaleString('pt-BR')}`);
  if (input.contingency) lines.push('*** EMITIDA EM CONTINGENCIA - SEM AUTORIZACAO ONLINE ***');
  lines.push(sep);
  for (const item of input.items) {
    lines.push(`${item.quantity}x ${item.name}`);
    lines.push(`   ${formatBRL(item.totalCents)}  NCM ${item.ncm}`);
  }
  lines.push(sep);
  lines.push(`TOTAL: ${formatBRL(input.amountCents)}`);
  lines.push(`PGTO: ${PAYMENT_LABEL[input.method]}${input.installments > 1 ? ` ${input.installments}x` : ''}`);
  lines.push(`NSU: ${input.nsu}`);
  lines.push(sep);
  lines.push('Chave de acesso:');
  lines.push(input.accessKey.replace(/(.{4})/g, '$1 ').trim());
  lines.push('Consulte pela chave em:');
  lines.push(input.qrCodeUrl.slice(0, 42));
  lines.push(...wrap(input.qrCodeUrl), sep);
  lines.push('XPARTNER BANK - Fiscal em tempo real');
  return lines.join('\n');
}

export function buildEscPos(danfeText: string): string {
  const ESC = '\x1b';
  const body = stripAccents(danfeText).split('\n').join('\r\n');
  return (
    `${ESC}@` +
    `${ESC}a\x01${ESC}E\x01XPARTNER\r\nNFC-e\r\n${ESC}E\x00` +
    `${ESC}a\x00\r\n${body}\r\n` +
    `${ESC}d\x03` +
    `\x1d\x56\x00`
  );
}

export function buildNfce(input: NfceInput, config: AppConfig): NfceResult {
  const cNF = numericCodeFrom(input.keySeed);
  const accessKey = generateAccessKey({
    cUF: config.fiscal.cUF,
    emittedAt: input.emittedAt,
    cnpj: input.merchant.cnpj,
    serie: input.serie,
    number: input.number,
    tpEmis: input.contingency ? '9' : '1',
    cNF,
  });
  const qrCodeUrl = buildQrCodeUrl(accessKey, input.ambiente);
  const unsigned = buildXml(input, accessKey, qrCodeUrl, config.fiscal.cUF);
  const xml = signNfceXml(unsigned, signingKey(config), accessKey);
  const danfeText = buildDanfeText({
    merchant: input.merchant,
    accessKey,
    number: input.number,
    serie: input.serie,
    emittedAt: input.emittedAt,
    items: input.items,
    amountCents: input.amountCents,
    method: input.method,
    installments: input.installments,
    nsu: input.nsu,
    contingency: input.contingency,
    qrCodeUrl,
  });
  return { accessKey, xml, qrCodeUrl, danfeText, escpos: buildEscPos(danfeText) };
}

export interface SefazResponse {
  authorized: boolean;
  protocol?: string;
  reason?: string;
}

/**
 * Transmissão simulada à SEFAZ. A falha é determinística por (chave, tentativa),
 * permitindo exercitar retry e contingência de forma reprodutível.
 */
export function transmitToSefaz(accessKey: string, attempt: number, rejectionPct: number): SefazResponse {
  const hash = sha256Hex(`sefaz:${accessKey}:${attempt}`);
  const draw = Number.parseInt(hash.slice(0, 8), 16) % 100;
  if (draw < rejectionPct) {
    const reasons = [
      '539 - Rejeicao: Duplicidade de NF-e com diferenca na chave de acesso',
      '999 - Rejeicao: Erro nao catalogado - falha de processamento',
      '604 - Rejeicao: NF-e com NFC-e em ambiente de homologacao sem valor',
    ];
    return { authorized: false, reason: reasons[draw % reasons.length] };
  }
  const protocol = (BigInt(`0x${hash.slice(0, 15)}`) % 1_000_000_000_000_000n).toString().padStart(15, '0');
  return { authorized: true, protocol };
}
