pragma circom 2.1.6;

// xPartner Bank — prova de predicado patrimonial (Groth16/BN254).
//
// O cliente prova off-chain que `netWorth >= threshold` sem revelar `netWorth`.
// `commitment` liga a prova a um compromisso Poseidon(netWorth, salt) que o banco
// registra no momento da adesão. `threshold` é público; `satisfied` é público e
// precisa ser 1, caso contrário a restrição falha e a testemunha não é aceita.
//
// Limite: valores são inteiros em centavos e precisam caber em 64 bits.
// O circuito cobre apenas a desigualdade — não prova identidade, renda ou lastro
// sem uma credencial externa que amarre o compromisso ao titular.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template NetWorthProof() {
    signal input netWorth;
    signal input salt;
    signal input threshold;

    signal output commitment;
    signal output satisfied;

    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== netWorth;
    commitmentHasher.inputs[1] <== salt;
    commitment <== commitmentHasher.out;

    component thresholdCheck = GreaterEqThan(64);
    thresholdCheck.in[0] <== netWorth;
    thresholdCheck.in[1] <== threshold;
    satisfied <== thresholdCheck.out;

    satisfied === 1;
}

component main {public [threshold]} = NetWorthProof();
