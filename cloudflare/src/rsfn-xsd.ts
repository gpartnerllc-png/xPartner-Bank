export const RSFN_PAG0004_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Contrato fechado do subconjunto PAG0004 usado pelo xPartner Bank.
  O XSD oficial do BCB é mais amplo (grupos, finalidades e campos opcionais).
  Este arquivo serve para validar integrações e gerar clientes de teste.
-->
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="http://bcb.gov.br"
           xmlns="http://bcb.gov.br"
           elementFormDefault="qualified">

  <xs:simpleType name="ISPB">
    <xs:restriction base="xs:string">
      <xs:pattern value="[0-9]{8}"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="NumCtrlIF">
    <xs:restriction base="xs:string">
      <xs:pattern value="[A-Z][0-9]{25}"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="Documento">
    <xs:restriction base="xs:string">
      <xs:pattern value="[0-9]{11}|[0-9]{14}"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="DataMovimento">
    <xs:restriction base="xs:string">
      <xs:pattern value="[0-9]{4}-[0-9]{2}-[0-9]{2}"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="Valor">
    <xs:restriction base="xs:string">
      <xs:pattern value="[0-9]{1,12}\\.[0-9]{2}"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="Finalidade">
    <xs:restriction base="xs:string">
      <xs:enumeration value="0001"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="Nome">
    <xs:restriction base="xs:string">
      <xs:minLength value="1"/>
      <xs:maxLength value="80"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:complexType name="BCType">
    <xs:sequence>
      <xs:element name="CodMsg" fixed="PAG0004"/>
      <xs:element name="NumCtrlIF" type="NumCtrlIF"/>
      <xs:element name="ISPBEmissor" type="ISPB"/>
      <xs:element name="ISPBDestinatario" type="ISPB"/>
      <xs:element name="DtMovto" type="DataMovimento"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="Pag0004Type">
    <xs:sequence>
      <xs:element name="CodCliEmissor">
        <xs:simpleType>
          <xs:restriction base="xs:string">
            <xs:pattern value="[0-9]{1,8}"/>
          </xs:restriction>
        </xs:simpleType>
      </xs:element>
      <xs:element name="CNPJ_CPFEmissor" type="Documento"/>
      <xs:element name="NomCliEmissor" type="Nome"/>
      <xs:element name="ContaDestinatario">
        <xs:simpleType>
          <xs:restriction base="xs:string">
            <xs:pattern value="[0-9]{1,12}"/>
          </xs:restriction>
        </xs:simpleType>
      </xs:element>
      <xs:element name="AgenciaDestinatario">
        <xs:simpleType>
          <xs:restriction base="xs:string">
            <xs:pattern value="[0-9]{1,6}"/>
          </xs:restriction>
        </xs:simpleType>
      </xs:element>
      <xs:element name="CNPJ_CPFDestinatario" type="Documento"/>
      <xs:element name="NomCliDestinatario" type="Nome"/>
      <xs:element name="VlrLanc" type="Valor"/>
      <xs:element name="FinalidadeTransacao" type="Finalidade"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="SISType">
    <xs:sequence>
      <xs:element name="PAG0004" type="Pag0004Type"/>
    </xs:sequence>
  </xs:complexType>

  <xs:element name="DOC">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="BC" type="BCType"/>
        <xs:element name="SIS" type="SISType"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>
`;
