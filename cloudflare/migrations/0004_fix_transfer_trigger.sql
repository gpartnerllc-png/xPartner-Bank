-- xPartner Bank · Edge v4 (correção aditiva)
-- O trigger original conferia o saldo DEPOIS do débito e recusava qualquer
-- transferência que deixasse o saldo restante menor que o valor movido.
-- A nova versão valida antes de mover e mantém o ledger de dupla entrada.
-- Nenhuma tabela é removida; apenas o trigger é recriado.

PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS bank_transfers_post;

CREATE TRIGGER bank_transfers_post
AFTER INSERT ON bank_transfers
WHEN NEW.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'DEBIT_ACCOUNT_INACTIVE')
   WHERE (SELECT status FROM bank_accounts WHERE id = NEW.debit_account_id) <> 'ACTIVE';

  SELECT RAISE(ABORT, 'INSUFFICIENT_FUNDS')
   WHERE (SELECT balance_cents FROM bank_accounts WHERE id = NEW.debit_account_id) < NEW.amount_cents;

  SELECT RAISE(ABORT, 'CREDIT_ACCOUNT_INACTIVE')
   WHERE (SELECT status FROM bank_accounts WHERE id = NEW.credit_account_id) <> 'ACTIVE';

  UPDATE bank_accounts
     SET balance_cents = balance_cents - NEW.amount_cents,
         updated_at = NEW.created_at
   WHERE id = NEW.debit_account_id;

  UPDATE bank_accounts
     SET balance_cents = balance_cents + NEW.amount_cents,
         updated_at = NEW.created_at
   WHERE id = NEW.credit_account_id;

  INSERT INTO bank_ledger (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, created_at)
  VALUES (
    NEW.id || '-D', NEW.id, NEW.debit_account_id, 'DEBIT', NEW.amount_cents,
    (SELECT balance_cents FROM bank_accounts WHERE id = NEW.debit_account_id),
    NEW.created_at
  );

  INSERT INTO bank_ledger (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, created_at)
  VALUES (
    NEW.id || '-C', NEW.id, NEW.credit_account_id, 'CREDIT', NEW.amount_cents,
    (SELECT balance_cents FROM bank_accounts WHERE id = NEW.credit_account_id),
    NEW.created_at
  );
END;
