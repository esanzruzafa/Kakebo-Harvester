import { z } from "zod";
import { normalizeDecimal } from "../transactions/transaction-mapper.js";
import { assertIsoDate } from "../utils/dates.js";

const sessionExpirySchema = z.string().transform((value, context) => {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Session expiry must be an ISO 8601 timestamp with a timezone."
    });
    return z.NEVER;
  }
  try {
    assertIsoDate(value.slice(0, 10), "session expiry");
  } catch {
    context.addIssue({
      code: "custom",
      message: "Session expiry must contain a real calendar date."
    });
    return z.NEVER;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    context.addIssue({
      code: "custom",
      message: "Session expiry must be a valid timestamp."
    });
    return z.NEVER;
  }
  return instant.toISOString();
});

const currencyCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/u, "Currency must be a three-letter ISO code."));

export const aspspSchema = z
  .object({
    name: z.string(),
    country: z.string().length(2),
    psu_types: z.array(z.enum(["personal", "business"])),
    auth_methods: z
      .array(
        z
          .object({
            name: z.string().optional(),
            title: z.string().optional(),
            approach: z.string(),
            psu_type: z.enum(["personal", "business"])
          })
          .loose()
      )
      .default([]),
    maximum_consent_validity: z.number().int().positive(),
    required_psu_headers: z.array(z.string()).optional()
  })
  .loose();

export const aspspsResponseSchema = z
  .object({ aspsps: z.array(aspspSchema) })
  .loose();

export const startAuthorizationResponseSchema = z
  .object({
    url: z.url().refine((value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username.length === 0 &&
        parsed.password.length === 0
      );
    }, "Authorization URL must use HTTPS and must not contain credentials."),
    authorization_id: z.string().optional()
  })
  .loose();

const accountIdentificationSchema = z
  .object({
    iban: z.string().nullish(),
    other: z.unknown().nullish()
  })
  .loose();

const providerAccountIdentifierSchema = z.string().trim().min(1);

export const accountSchema = z
  .object({
    uid: providerAccountIdentifierSchema,
    identification_hash: z.string().nullish(),
    identification_hashes: z.array(z.string()).nullish(),
    account_id: accountIdentificationSchema.nullish(),
    name: z.string().nullish(),
    details: z.string().nullish(),
    currency: z.string().nullish(),
    cash_account_type: z.string().nullish(),
    product: z.unknown().optional()
  })
  .loose();

export const sessionResponseSchema = z
  .object({
    session_id: providerAccountIdentifierSchema,
    accounts: z.array(accountSchema),
    access: z.object({ valid_until: sessionExpirySchema }).loose().optional()
  })
  .loose();

export const getSessionResponseSchema = z
  .object({
    status: z.string(),
    accounts: z.array(providerAccountIdentifierSchema),
    accounts_data: z
      .array(
        z
          .object({
            uid: providerAccountIdentifierSchema,
            identification_hash: z.string().nullish()
          })
          .loose()
      )
      .default([]),
    access: z.object({ valid_until: sessionExpirySchema }).loose().optional()
  })
  .loose();

export const balancesResponseSchema = z
  .object({
    balances: z.array(
      z
        .object({
          name: z.string().optional(),
          balance_amount: z.object({
            currency: currencyCodeSchema,
            amount: z.string().transform((value, context) => {
              try {
                return normalizeDecimal(value).amount;
              } catch {
                context.addIssue({
                  code: "custom",
                  message: "Balance amount must be a valid decimal."
                });
                return z.NEVER;
              }
            })
          }),
          balance_type: z.string().optional(),
          last_change_date_time: z.string().nullish(),
          reference_date: z.string().nullish()
        })
        .loose()
    )
  })
  .loose();

const partySchema = z.object({ name: z.string().nullish() }).loose();
const creditDebitIndicatorSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(["DBIT", "CRDT"]));
const partyAccountSchema = z
  .object({
    iban: z.string().nullish(),
    other: z.unknown().nullish()
  })
  .loose();

export const transactionSchema = z
  .object({
    entry_reference: z.string().nullish(),
    transaction_id: z.string().nullish(),
    transaction_amount: z.object({
      currency: currencyCodeSchema,
      amount: z.string()
    }),
    credit_debit_indicator: creditDebitIndicatorSchema.nullish(),
    status: z.string().nullish(),
    booking_date: z.string().nullish(),
    value_date: z.string().nullish(),
    transaction_date: z.string().nullish(),
    remittance_information: z
      .union([z.array(z.string()), z.string()])
      .nullish(),
    note: z.string().nullish(),
    merchant_category_code: z.string().nullish(),
    creditor: partySchema.nullish(),
    debtor: partySchema.nullish(),
    creditor_account: partyAccountSchema.nullish(),
    debtor_account: partyAccountSchema.nullish(),
    bank_transaction_code: z
      .object({
        code: z.string().nullish(),
        sub_code: z.string().nullish(),
        description: z.string().nullish()
      })
      .loose()
      .nullish(),
    balance_after_transaction: z
      .object({
        currency: currencyCodeSchema,
        amount: z.string()
      })
      .nullish()
  })
  .loose();

export const transactionsResponseSchema = z
  .object({
    transactions: z.array(transactionSchema),
    continuation_key: z.string().nullable().optional()
  })
  .loose();

export type Aspsp = z.infer<typeof aspspSchema>;
export type AccountResource = z.infer<typeof accountSchema>;
export type ProviderTransaction = z.infer<typeof transactionSchema>;
