#!/usr/bin/env node
/**
 * Recompila o circuito de predicado patrimonial e regenera os artefatos Groth16.
 *
 * ATENÇÃO: a cerimônia abaixo é de demonstração (uma única contribuição local).
 * Reexecutar substitui wasm/zkey/vkey e invalida provas e o verifier Solidity
 * anteriores. Em produção, use uma cerimônia multi-participante auditada e
 * publique os hashes dos artefatos.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'circuits', 'build');
const circuit = path.join(root, 'circuits', 'NetWorthProof.circom');
mkdirSync(build, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} falhou com status ${result.status}`);
  }
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const pot0 = path.join(build, 'pot12_0000.ptau');
const pot1 = path.join(build, 'pot12_0001.ptau');
const potFinal = path.join(build, 'pot12_final.ptau');
const zkey0 = path.join(build, 'NetWorthProof_0000.zkey');
const zkey = path.join(build, 'NetWorthProof.zkey');
const wasmDir = path.join(build, 'NetWorthProof_js');

const entropy = randomBytes(32).toString('hex');

run(npx, ['--no-install', 'circom2', circuit, '--r1cs', '--wasm', '-l', 'node_modules', '-o', build]);
run(npx, ['--no-install', 'snarkjs', 'powersoftau', 'new', 'bn128', '12', pot0, '-v']);
run(npx, ['--no-install', 'snarkjs', 'powersoftau', 'contribute', pot0, pot1, '--name=xpartner-demo', '-e', entropy]);
run(npx, ['--no-install', 'snarkjs', 'powersoftau', 'prepare', 'phase2', pot1, potFinal]);
run(npx, ['--no-install', 'snarkjs', 'groth16', 'setup', path.join(build, 'NetWorthProof.r1cs'), potFinal, zkey0]);
run(npx, ['--no-install', 'snarkjs', 'zkey', 'contribute', zkey0, zkey, '--name=xpartner-demo', '-e', entropy]);
run(npx, ['--no-install', 'snarkjs', 'zkey', 'export', 'verificationkey', zkey, path.join(build, 'verification_key.json')]);
run(npx, ['--no-install', 'snarkjs', 'zkey', 'export', 'solidityverifier', zkey, path.join(root, 'contracts', 'generated', 'NetWorthVerifier.sol')]);

for (const file of [pot0, pot1, potFinal, zkey0]) rmSync(file, { force: true });

const wasm = path.join(build, 'NetWorthProof.wasm');
const wasmOutput = path.join(wasmDir, 'NetWorthProof.wasm');
if (wasmOutput !== wasm) {
  rmSync(wasm, { force: true });
  renameSync(wasmOutput, wasm);
}
rmSync(wasmDir, { recursive: true, force: true });

for (const file of [wasm, zkey, path.join(build, 'verification_key.json')]) {
  const size = statSync(file).size;
  console.log(`${path.relative(root, file)} — ${(size / 1024).toFixed(1)} KiB`);
}
console.log('artefatos:', readdirSync(build).join(', '));
