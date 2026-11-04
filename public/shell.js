/**
 * Barra única do xPartner Bank.
 * Toda página carrega o mesmo menu: as repartições da loja, as do banco, a
 * sessão de quem entrou e a saída. Assim nenhuma tela vira beco sem volta.
 */
(function () {
  'use strict';

  var AREAS = [
    {
      id: 'loja',
      titulo: 'Sua loja',
      resumo: 'O movimento do cartão, do Pix e das cobranças.',
      itens: [
        { href: '/#visao', nome: 'Visão geral', dica: 'Saldo, volume e aprovação do dia' },
        { href: '/#vendas', nome: 'Vendas', dica: 'Cada venda feita na maquininha' },
        { href: '/#fiscal', nome: 'Notas fiscais', dica: 'NFC-e, XML assinado e DANFE' },
        { href: '/#risco', nome: 'Risco e antifraude', dica: 'Bloqueios, suspeitas e limites' },
        { href: '/#ledger', nome: 'Livro-caixa', dica: 'Dupla entrada conferida centavo a centavo' },
        { href: '/app', nome: 'Aplicativo do lojista', dica: 'Conta, cobranças e clientes num lugar só' },
        { href: '/app#charges', nome: 'Cobranças', dica: 'Boletos, Pix e links de pagamento' },
        { href: '/app#subscriptions', nome: 'Assinaturas', dica: 'Cobrança recorrente e faturas' },
        { href: '/app#customers', nome: 'Clientes', dica: 'Cadastrar, editar, bloquear e excluir' },
        { href: '/app#settlements', nome: 'Recebíveis e antecipação', dica: 'O que entra e quando entra' },
        { href: '/app#openfinance', nome: 'Open Finance', dica: 'Consentimentos, débitos e pagamentos' },
        { href: '/app#investments', nome: 'Investimentos', dica: 'Aplicações, proventos e resgates' },
      ],
    },
    {
      id: 'banco',
      titulo: 'O banco',
      resumo: 'Sua conta, seu dinheiro emprestado e o caminho das pagamentos.',
      itens: [
        { href: '/bank#overview', nome: 'Visão geral do banco', dica: 'Saldo, contas e atalhos' },
        { href: '/bank#transfer', nome: 'Transferir', dica: 'TED, Pix e boletos entre contas' },
        { href: '/bank#pix', nome: 'Pix', dica: 'Chaves, cobranças e recebimentos' },
        { href: '/bank#statement', nome: 'Extrato', dica: 'Cada lançamento com contrapartida' },
        { href: '/bank#score', nome: 'Score', dica: 'Nota de crédito e o que muda ela' },
        { href: '/bank#credit', nome: 'Crédito', dica: 'Linha, parcelas e antecipação' },
        { href: '/bank#rsfn', nome: 'RSFN · PAG0004', dica: 'Arquivo oficial do banco central' },
        { href: '/bank#security', nome: 'Senha e sessão', dica: 'Trocar senha e encerrar sessão' },
      ],
    },
    {
      id: 'ativos',
      titulo: 'Ativos e tecnologia',
      resumo: 'Moeda digital, títulos tokenizados e a porta de entrada para sistemas.',
      itens: [
        { href: '/bank#web3', nome: 'Ativos digitais', dica: 'Carteira, chains e contratos' },
        { href: '/bank#tokenization', nome: 'Tokenização', dica: 'Renda fixa, DePIN e bioativos' },
        { href: '/bank#api', nome: 'API e documentação', dica: 'Testar chamadas e ler contratos' },
        { href: '/docs', nome: 'Documentação aberta', dica: 'Guia rápido sem precisar entrar' },
      ],
    },
    {
      id: 'admin',
      titulo: 'Administração',
      resumo: 'Só aparece para quem é administrador do banco.',
      admin: true,
      itens: [
        { href: '/bank#admin', nome: 'Console do administrador', dica: 'Aprovar contas, cadastro e limpeza' },
        { href: '/core', nome: 'Core bancário', dica: 'Engrenagens, filas e métricas' },
      ],
    },
  ];

  var PAPEL = { ADMIN: 'Administrador', USER: 'Cliente', SYSTEM: 'Sistema' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function iniciais(nome) {
    var partes = String(nome || 'x').trim().split(/\s+/);
    return ((partes[0] || 'x').charAt(0) + (partes[1] || '').charAt(0)).toUpperCase();
  }

  function areaAtual() {
    var caminho = location.pathname;
    if (caminho === '/app' || caminho === '/app.html') return 'loja';
    if (caminho === '/bank' || caminho === '/bank.html') return 'banco';
    if (caminho === '/core' || caminho === '/core.html') return 'admin';
    return 'loja';
  }

  function montarBarra() {
    if (document.getElementById('xpShell')) return null;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/shell.css';
    link.addEventListener('load', function () { mediraAltura(barra); });
    document.head.appendChild(link);

    var barra = document.createElement('nav');
    barra.id = 'xpShell';
    barra.className = 'xp-shell';
    barra.setAttribute('aria-label', 'Navegação do banco');

    var atual = areaAtual();
    var grupos = '';
    for (var i = 0; i < AREAS.length; i++) {
      var area = AREAS[i];
      grupos +=
        '<div class="xp-grupo' + (area.admin ? ' xp-so-admin' : '') + '"' +
        (area.admin ? ' hidden' : '') + ' data-grupo="' + area.id + '">' +
        '<button type="button" class="xp-abrir' + (atual === area.id ? ' atual' : '') + '" aria-expanded="false">' +
        esc(area.titulo) + '<span class="xp-seta">▾</span></button>' +
        '<div class="xp-painel" role="menu" hidden>' +
        '<p class="xp-resumo">' + esc(area.resumo) + '</p>' +
        area.itens.map(function (item) {
          return (
            '<a role="menuitem" href="' + item.href + '"><b>' + esc(item.nome) + '</b><small>' + esc(item.dica) + '</small></a>'
          );
        }).join('') +
        '</div></div>';
    }

    barra.innerHTML =
      '<div class="xp-inner">' +
      '<div class="xp-areas">' +
      '<span class="xp-selo">xPartner</span>' + grupos +
      '</div>' +
      '<div class="xp-sessao" id="xpSessao">' +
      '<span class="xp-carregando">conferindo acesso…</span>' +
      '</div>' +
      '</div>';

    var topo = document.querySelector('header.topbar') || document.querySelector('.topbar');
    var host = topo && topo.parentNode ? topo.parentNode : document.body;
    host.insertBefore(barra, topo || host.firstChild);

    // O CSS chega depois da barra; sem observar o tamanho, a barra da página
    // ficaria colada na altura errada.
    mediraAltura(barra);
    if (typeof ResizeObserver === 'function') {
      var observador = new ResizeObserver(function () { mediraAltura(barra); });
      observador.observe(barra);
    }
    window.addEventListener('resize', function () { mediraAltura(barra); });
    window.addEventListener('load', function () { mediraAltura(barra); });

    ligarMenus(barra);
    return barra;
  }

  /** A altura da barra empurra a barra fixa da própria página para baixo. */
  function mediraAltura(barra) {
    document.documentElement.style.setProperty('--xp-shell-h', barra.offsetHeight + 'px');
  }

  function fecharTodos(barra, exceto) {
    var paineis = barra.querySelectorAll('.xp-painel');
    for (var i = 0; i < paineis.length; i++) {
      var painel = paineis[i];
      var abrir = painel.parentNode.querySelector('.xp-abrir');
      var aberto = painel.parentNode !== exceto;
      painel.hidden = aberto;
      abrir.setAttribute('aria-expanded', aberto ? 'false' : 'true');
      abrir.classList.toggle('aberto', !aberto);
    }
  }

  function ligarMenus(barra) {
    var botoes = barra.querySelectorAll('.xp-abrir');
    for (var i = 0; i < botoes.length; i++) {
      (function (botao) {
        botao.addEventListener('click', function (evento) {
          evento.preventDefault();
          evento.stopPropagation();
          var painel = botao.parentNode.querySelector('.xp-painel');
          fecharTodos(barra, painel.hidden ? botao.parentNode : null);
        });
      })(botoes[i]);
    }
    document.addEventListener('click', function () { fecharTodos(barra, null); });
    document.addEventListener('keydown', function (evento) {
      if (evento.key === 'Escape') fecharTodos(barra, null);
    });
  }

  function pintaSessao(barra, me) {
    var alvo = barra.querySelector('#xpSessao');
    var noBanco = areaAtual() === 'banco';
    if (!me || !me.user) {
      alvo.innerHTML =
        '<span class="xp-visita">Você está sem entrar</span>' +
        '<a class="xp-primario" href="/bank">Entrar no banco</a>';
      mediraAltura(barra);
      return;
    }
    var nome = String(me.user.name || me.user.email || 'Cliente');
    var primeiro = nome.split(' ')[0] || nome;
    alvo.innerHTML =
      '<span class="xp-quem"><i>' + esc(iniciais(nome)) + '</i><b>' + esc(primeiro) +
      '</b><small>' + esc(PAPEL[me.user.role] || 'Cliente') + '</small></span>' +
      (noBanco ? '' : '<a class="xp-primario" href="/bank">Voltar ao banco</a>') +
      '<button type="button" class="xp-sair" id="xpSair">Sair</button>';
    mediraAltura(barra);
    var sair = alvo.querySelector('#xpSair');
    sair.addEventListener('click', function () {
      sair.disabled = true;
      fetch('/v1/bank/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-bank-csrf': me.csrfToken || '' },
        body: '{}',
      })
        .catch(function () { /* sessão já era encerrada */ })
        .then(function () { location.href = '/bank'; });
    });
    var grupos = barra.querySelectorAll('.xp-so-admin');
    for (var i = 0; i < grupos.length; i++) {
      grupos[i].hidden = me.user.role !== 'ADMIN';
    }
  }

  var sessao = null;
  var conferida = false;
  var emBusca = null;
  var barras = [];

  /** Uma conferência por vez: a barra e o cartão de acesso da página dividem o mesmo pedido. */
  function conferirSessao(forcar) {
    if (!forcar && conferida && !emBusca) return Promise.resolve(sessao);
    if (forcar) emBusca = null;
    if (!emBusca) {
      emBusca = fetch('/v1/bank/me', { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; })
        .then(function (me) {
          emBusca = null;
          sessao = me;
          conferida = true;
          for (var i = 0; i < barras.length; i++) pintaSessao(barras[i], me);
          return me;
        });
    }
    return emBusca;
  }

  window.xpSessaoBanco = {
    conferir: conferirSessao,
    atual: function () { return sessao; },
  };

  function iniciar() {
    var barra = montarBarra();
    if (!barra) return;
    barras.push(barra);
    conferirSessao(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
