import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestServer } from './test-server.ts';

const PAGINAS = ['/', '/app', '/bank', '/core', '/docs', '/web3', '/tokenization'];

test('navegação única: toda página carrega a barra do banco', async () => {
  const ctx = await buildTestServer();
  try {
    for (const url of PAGINAS) {
      const page = await ctx.app.inject({ method: 'GET', url });
      assert.equal(page.statusCode, 200, `${url} deveria responder 200`);
      assert.match(page.body, /src="\/shell\.js"/, `${url} deveria carregar a barra única`);
    }

    const script = await ctx.app.inject({ method: 'GET', url: '/shell.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'] as string, /javascript/);
    assert.match(script.body, /xpShell/);
    assert.match(script.body, /Voltar ao banco/);
    assert.match(script.body, /Sua loja/);
    assert.match(script.body, /O banco/);

    const css = await ctx.app.inject({ method: 'GET', url: '/shell.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'] as string, /text\/css/);
    assert.match(css.body, /\.xp-shell/);
  } finally {
    await ctx.app.close();
  }
});

test('acesso dentro do painel da loja: entrar, sair e voltar ao banco sem trocar de tela', async () => {
  const ctx = await buildTestServer();
  try {
    const painel = await ctx.app.inject({ method: 'GET', url: '/' });
    assert.match(painel.body, /id="acesso"/);
    assert.match(painel.body, /Acesso ao banco/);
    assert.match(painel.body, /id="acessoForm"/);
    assert.match(painel.body, /id="acessoSair"/);
    assert.match(painel.body, /href="\/bank"/);
  } finally {
    await ctx.app.close();
  }
});
