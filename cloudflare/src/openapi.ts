const auth = [{ sessionCookie: [] }, { bearerAuth: [] }];

const csrf = {
  name: 'x-bank-csrf',
  in: 'header',
  required: false,
  description:
    'Obrigatório em requisições de escrita autenticadas por cookie. Use o csrfToken devolvido por GET /v1/bank/me.',
  schema: { type: 'string' },
};

const idempotency = {
  name: 'idempotency-key',
  in: 'header',
  required: false,
  description: 'Repete a resposta original da transferência sem mover saldo de novo.',
  schema: { type: 'string' },
};

const ok = (description: string) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
});

const erro = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
  },
});

const valor = {
  type: 'object',
  properties: {
    amountCents: { type: 'integer', description: 'Valor em centavos (recomendado).' },
    amount: { type: 'string', description: 'Valor em reais, aceita "1.234,56".' },
  },
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'xPartner Bank — Edge API',
    version: '1.0.0-edge',
    description:
      'Contrato do Worker xPartner Bank no Cloudflare. Dinheiro em centavos, ledger de dupla entrada em D1, comprovantes em R2, eventos em Queues e insights com Workers AI. Sessões por cookie HttpOnly (xp_bank_session) exigem o header x-bank-csrf nas escritas; tokens Bearer também são aceitos.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Público' },
    { name: 'Autenticação' },
    { name: 'Conta' },
    { name: 'Pix' },
    { name: 'Crédito' },
    { name: 'RSFN' },
    { name: 'Transferências' },
    { name: 'Demo' },
    { name: 'Administração' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Público'],
        summary: 'Verificação de disponibilidade do Worker',
        security: [],
        responses: { '200': ok('Serviço disponível') },
      },
    },
    '/v1/bank/status': {
      get: {
        tags: ['Público'],
        summary: 'Modo demo, contagem de clientes e integrações ativas',
        security: [],
        responses: { '200': ok('Estado do edge bancário') },
      },
    },
    '/v1/bank/auth/register': {
      post: {
        tags: ['Autenticação'],
        summary: 'Cria cadastro e, no modo demo, a primeira conta vira admin',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'document', 'email', 'password'],
                properties: {
                  name: { type: 'string' },
                  document: { type: 'string', description: 'CPF ou CNPJ' },
                  email: { type: 'string', format: 'email' },
                  phone: { type: 'string' },
                  password: { type: 'string', minLength: 10 },
                },
              },
            },
          },
        },
        responses: {
          '201': ok('Cadastro criado'),
          '400': erro('Dados inválidos'),
          '409': erro('Documento ou e-mail já cadastrado'),
          '429': erro('Limite de tentativas'),
        },
      },
    },
    '/v1/bank/auth/login': {
      post: {
        tags: ['Autenticação'],
        summary: 'Inicia sessão por documento, e-mail ou conta',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['identifier', 'password'],
                properties: {
                  identifier: { type: 'string' },
                  email: { type: 'string', description: 'Alternativa a identifier.' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': ok('Sessão iniciada'),
          '401': erro('Credenciais inválidas'),
          '403': erro('Conta pendente ou bloqueada'),
        },
      },
    },
    '/v1/bank/auth/logout': {
      post: {
        tags: ['Autenticação'],
        summary: 'Encerra a sessão atual',
        security: auth,
        parameters: [csrf],
        responses: { '200': ok('Sessão encerrada') },
      },
    },
    '/v1/bank/auth/change-password': {
      post: {
        tags: ['Autenticação'],
        summary: 'Troca a senha e revoga as demais sessões',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: { type: 'string', minLength: 10 },
                },
              },
            },
          },
        },
        responses: { '200': ok('Senha alterada'), '400': erro('Senha fraca ou atual inválida') },
      },
    },
    '/v1/bank/me': {
      get: {
        tags: ['Conta'],
        summary: 'Usuário, conta, CSRF e validade da sessão',
        security: auth,
        responses: { '200': ok('Sessão atual'), '401': erro('Não autenticado') },
      },
    },
    '/v1/bank/account': {
      get: {
        tags: ['Conta'],
        summary: 'Conta corrente com saldo e limites',
        security: auth,
        responses: { '200': ok('Conta corrente'), '404': erro('Conta não encontrada') },
      },
    },
    '/v1/bank/statement': {
      get: {
        tags: ['Conta'],
        summary: 'Extrato com saldo após cada partida',
        security: auth,
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
        ],
        responses: { '200': ok('Extrato') },
      },
    },
    '/v1/bank/statement.csv': {
      get: {
        tags: ['Conta'],
        summary: 'Extrato em CSV',
        security: auth,
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          '200': {
            description: 'Arquivo CSV',
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/v1/bank/recipients/lookup': {
      get: {
        tags: ['Transferências'],
        summary: 'Confere o favorecido antes de transferir',
        security: auth,
        parameters: [
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string', enum: ['accountNumber', 'document', 'email', 'pix'] },
          },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': ok('Favorecido encontrado'), '404': erro('Favorecido não encontrado') },
      },
    },
    '/v1/bank/credit/score': {
      get: {
        tags: ['Conta'],
        summary: 'Score interno e limite sugerido',
        security: auth,
        responses: { '200': ok('Score interno') },
      },
    },
    '/v1/bank/fx/wallets': {
      get: {
        tags: ['Conta'],
        summary: 'Carteiras internacionais do cliente',
        security: auth,
        responses: { '200': ok('Carteiras FX') },
      },
    },
    '/v1/bank/ai/insights': {
      post: {
        tags: ['Conta'],
        summary: 'Insights do extrato com Workers AI',
        security: auth,
        parameters: [csrf],
        responses: { '200': ok('Insights'), '503': erro('IA indisponível') },
      },
    },
    '/v1/bank/pix/keys': {
      get: {
        tags: ['Pix'],
        summary: 'Lista as chaves Pix do cliente e o limite de 5 ativas',
        security: auth,
        responses: { '200': ok('Chaves Pix') },
      },
      post: {
        tags: ['Pix'],
        summary: 'Cadastra chave CPF, CNPJ, e-mail ou telefone',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'value'],
                properties: {
                  type: { type: 'string', enum: ['CPF', 'CNPJ', 'EMAIL', 'PHONE'] },
                  value: { type: 'string' },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': ok('Chave cadastrada'),
          '409': erro('Chave já cadastrada'),
          '422': erro('Chave inválida ou limite atingido'),
          '429': erro('Limite de tentativas'),
        },
      },
    },
    '/v1/bank/pix/keys/evp': {
      post: {
        tags: ['Pix'],
        summary: 'Gera chave aleatória (EVP)',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { label: { type: 'string' } } },
            },
          },
        },
        responses: { '201': ok('Chave EVP criada'), '422': erro('Limite de chaves atingido') },
      },
    },
    '/v1/bank/pix/keys/{id}': {
      delete: {
        tags: ['Pix'],
        summary: 'Remove uma chave Pix do cliente',
        security: auth,
        parameters: [csrf, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Chave removida'), '404': erro('Chave não encontrada') },
      },
    },
    '/v1/bank/pix/keys/{id}/brcode': {
      get: {
        tags: ['Pix'],
        summary: 'BR Code EMV com CRC16 para uma chave do cliente',
        security: auth,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'amountCents', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: { '200': ok('BR Code'), '404': erro('Chave não encontrada') },
      },
    },
    '/v1/bank/credit/quote': {
      post: {
        tags: ['Crédito'],
        summary: 'Simula antecipação (30 dias, 1x) ou empréstimo (até 12x) pela tabela Price',
        security: auth,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  product: { type: 'string', enum: ['ANTECIPACAO', 'EMPRESTIMO'] },
                  amountCents: { type: 'integer' },
                  installments: { type: 'integer', minimum: 1, maximum: 12 },
                },
              },
            },
          },
        },
        responses: { '200': ok('Simulação'), '422': erro('Valor ou parcelas fora do intervalo') },
      },
    },
    '/v1/bank/credit/contracts': {
      get: {
        tags: ['Crédito'],
        summary: 'Contratos de crédito do cliente com parcelas',
        security: auth,
        responses: { '200': ok('Contratos') },
      },
      post: {
        tags: ['Crédito'],
        summary: 'Contrata crédito e credita o principal na conta',
        security: auth,
        parameters: [csrf, idempotency],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  product: { type: 'string', enum: ['ANTECIPACAO', 'EMPRESTIMO'] },
                  amountCents: { type: 'integer' },
                  installments: { type: 'integer', minimum: 1, maximum: 12 },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': ok('Contrato criado'),
          '200': ok('Replay idempotente'),
          '409': erro('Limite ou tesouraria insuficiente'),
          '429': erro('Limite de tentativas'),
        },
      },
    },
    '/v1/bank/credit/contracts.csv': {
      get: {
        tags: ['Crédito'],
        summary: 'Exporta os contratos do cliente em CSV',
        security: auth,
        responses: { '200': { description: 'CSV dos contratos', content: { 'text/csv': { schema: { type: 'string' } } } } },
      },
    },
    '/v1/bank/credit/contracts/{id}': {
      get: {
        tags: ['Crédito'],
        summary: 'Detalhe do contrato e parcelas',
        security: auth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Contrato'), '404': erro('Contrato não encontrado') },
      },
    },
    '/v1/bank/credit/contracts/{id}/installments/{number}/pay': {
      post: {
        tags: ['Crédito'],
        summary: 'Paga uma parcela com débito em conta',
        security: auth,
        parameters: [
          csrf,
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'number', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '201': ok('Parcela paga'),
          '409': erro('Parcela já paga ou saldo insuficiente'),
          '404': erro('Contrato ou parcela não encontrada'),
        },
      },
    },
    '/v1/bank/credit/contracts/{id}/settle': {
      post: {
        tags: ['Crédito'],
        summary: 'Quita antecipadamente as parcelas em aberto',
        security: auth,
        parameters: [csrf, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': ok('Contrato quitado'), '409': erro('Saldo insuficiente ou contrato já pago') },
      },
    },
    '/v1/bank/rsfn/config': {
      get: {
        tags: ['RSFN'],
        summary: 'ISPB, limites e modo demo da integração RSFN',
        security: auth,
        responses: { '200': ok('Configuração RSFN') },
      },
    },
    '/v1/bank/rsfn/pag0004.xsd': {
      get: {
        tags: ['RSFN'],
        summary: 'XSD fechado do subconjunto PAG0004 usado pelo banco',
        security: [],
        responses: {
          '200': { description: 'XSD', content: { 'application/xml': { schema: { type: 'string' } } } },
        },
      },
    },
    '/v1/bank/rsfn/validate': {
      post: {
        tags: ['RSFN'],
        summary: 'Valida um XML PAG0004 sem movimentar saldo',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['xml'], properties: { xml: { type: 'string' } } },
            },
          },
        },
        responses: { '200': ok('Resultado da validação'), '422': erro('XML inválido') },
      },
    },
    '/v1/bank/rsfn/transfers': {
      post: {
        tags: ['RSFN'],
        summary: 'Envia PAG0004 e debita a conta do emissor',
        security: auth,
        parameters: [csrf, idempotency],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amountCents: valor.properties.amountCents,
                  description: { type: 'string' },
                  destination: {
                    type: 'object',
                    properties: {
                      ispb: { type: 'string', description: 'ISPB de 8 dígitos.' },
                      branch: { type: 'string' },
                      account: { type: 'string' },
                      document: { type: 'string', description: 'CPF ou CNPJ do favorecido.' },
                      name: { type: 'string' },
                    },
                  },
                  clientCode: { type: 'string' },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': ok('Mensagem aceita para envio'),
          '200': ok('Replay idempotente'),
          '409': erro('Saldo insuficiente'),
          '422': erro('Destino inválido ou acima do limite'),
          '429': erro('Limite de tentativas'),
        },
      },
    },
    '/v1/bank/rsfn/messages': {
      get: {
        tags: ['RSFN'],
        summary: 'Mensagens RSFN do cliente',
        security: auth,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
        responses: { '200': ok('Mensagens') },
      },
    },
    '/v1/bank/rsfn/messages/{id}': {
      get: {
        tags: ['RSFN'],
        summary: 'Detalhe e XML de uma mensagem RSFN',
        security: auth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Mensagem'), '404': erro('Mensagem não encontrada') },
      },
    },
    '/v1/bank/rsfn/messages/{id}/xml': {
      get: {
        tags: ['RSFN'],
        summary: 'Baixa o XML PAG0004 armazenado',
        security: auth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'XML', content: { 'application/xml': { schema: { type: 'string' } } } },
          '404': erro('Mensagem não encontrada'),
        },
      },
    },
    '/v1/bank/rsfn/messages/{id}/ack': {
      post: {
        tags: ['RSFN'],
        summary: 'Admin aceita ou rejeita a mensagem; rejeição estorna o valor',
        security: auth,
        parameters: [csrf, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['ACCEPT', 'REJECT'] },
                  rejectionCode: { type: 'string' },
                  rejectionReason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': ok('Mensagem liquidada'),
          '201': ok('Mensagem rejeitada com estorno'),
          '403': erro('Restrito ao administrador'),
          '409': erro('Mensagem já finalizada'),
        },
      },
    },
    '/v1/bank/transfers': {
      post: {
        tags: ['Transferências'],
        summary: 'Transferência interna com dupla entrada atômica',
        security: auth,
        parameters: [csrf, idempotency],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amountCents: valor.properties.amountCents,
                  amount: valor.properties.amount,
                  description: { type: 'string' },
                  recipient: {
                    type: 'object',
                    properties: {
                      accountNumber: { type: 'string' },
                      document: { type: 'string' },
                      email: { type: 'string' },
                      pixKey: { type: 'string', description: 'Chave Pix ativa de outro cliente.' },
                    },
                  },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': ok('Transferência postada'),
          '200': ok('Replay idempotente'),
          '409': erro('Saldo insuficiente ou chave já usada'),
        },
      },
    },
    '/v1/bank/transfers/{id}': {
      get: {
        tags: ['Transferências'],
        summary: 'Comprovante da transferência',
        security: auth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Comprovante'), '404': erro('Transferência não encontrada') },
      },
    },
    '/v1/bank/receipts/{id}': {
      get: {
        tags: ['Transferências'],
        summary: 'Comprovante arquivado no R2',
        security: auth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Comprovante em JSON') },
      },
    },
    '/v1/bank/demo/credit': {
      post: {
        tags: ['Demo'],
        summary: 'Aporte de tesouraria para a própria conta (admin pode escolher o destino)',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amountCents: valor.properties.amountCents,
                  amount: valor.properties.amount,
                  targetUserId: { type: 'string', description: 'Somente admin.' },
                },
              },
            },
          },
        },
        responses: { '201': ok('Aporte creditado'), '409': erro('Tesouraria sem saldo') },
      },
    },
    '/v1/bank/demo/capital': {
      post: {
        tags: ['Demo'],
        summary: 'Capital demo para uma conta (somente admin)',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['targetUserId'],
                properties: {
                  targetUserId: { type: 'string' },
                  amountCents: valor.properties.amountCents,
                  amount: valor.properties.amount,
                },
              },
            },
          },
        },
        responses: { '201': ok('Capital postado'), '409': erro('Capital demo esgotado') },
      },
    },
    '/v1/bank/demo/fx': {
      post: {
        tags: ['Demo'],
        summary: 'Aporte em dólar na carteira FX (somente admin)',
        security: auth,
        parameters: [csrf],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['targetUserId'],
                properties: {
                  targetUserId: { type: 'string' },
                  currency: { type: 'string', enum: ['USD'] },
                  amountCents: valor.properties.amountCents,
                  amount: valor.properties.amount,
                },
              },
            },
          },
        },
        responses: { '201': ok('Aporte FX postado'), '409': erro('Tesouraria USD sem saldo') },
      },
    },
    '/v1/bank/admin/overview': {
      get: {
        tags: ['Administração'],
        summary: 'Painel do administrador com ledger e carteiras FX',
        security: auth,
        responses: { '200': ok('Visão geral'), '403': erro('Requer admin') },
      },
    },
    '/v1/bank/admin/users': {
      get: {
        tags: ['Administração'],
        summary: 'Lista clientes com conta e saldo',
        security: auth,
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'ACTIVE', 'BLOCKED', 'DELETED'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
        ],
        responses: { '200': ok('Clientes'), '403': erro('Requer admin') },
      },
    },
    '/v1/bank/admin/audit': {
      get: {
        tags: ['Administração'],
        summary: 'Trilha de auditoria',
        security: auth,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
        responses: { '200': ok('Auditoria'), '403': erro('Requer admin') },
      },
    },
    '/v1/bank/admin/users/{id}': {
      get: {
        tags: ['Administração'],
        summary: 'Detalhe do cliente, score e extrato',
        security: auth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Detalhe'), '404': erro('Cliente não encontrado') },
      },
      delete: {
        tags: ['Administração'],
        summary: 'Exclui cliente sem saldo e encerra a conta',
        security: auth,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          csrf,
        ],
        responses: { '200': ok('Cliente excluído'), '409': erro('Saldo diferente de zero') },
      },
    },
    '/v1/bank/admin/users/{id}/{action}': {
      post: {
        tags: ['Administração'],
        summary: 'Aprova, recusa, bloqueia, desbloqueia ou redefine a senha',
        security: auth,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'action',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['approve', 'reject', 'block', 'unblock', 'reset-password'],
            },
          },
          csrf,
        ],
        responses: { '200': ok('Ação aplicada'), '404': erro('Cliente não encontrado') },
      },
    },
    '/v1/bank/admin/pix/keys': {
      get: {
        tags: ['Administração'],
        summary: 'Lista chaves Pix de todos os clientes',
        security: auth,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
        responses: { '200': ok('Chaves Pix'), '403': erro('Requer admin') },
      },
    },
    '/v1/bank/admin/rsfn/messages': {
      get: {
        tags: ['Administração'],
        summary: 'Lista mensagens RSFN de todos os clientes',
        security: auth,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
        responses: { '200': ok('Mensagens RSFN'), '403': erro('Requer admin') },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'xp_bank_session' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
  },
};
