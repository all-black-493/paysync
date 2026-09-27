import { z } from 'zod'

// One schema per product. Result codes are strings in some products and
// numbers in others, so each product normalizes its own codes (normalize.ts).

export const OAuthResponse = z.object({
  access_token: z.string().min(10),
  // Documented as a number; the sandbox sends the string "3599".
  expires_in: z.union([z.string().regex(/^\d+$/), z.number().int()]).transform(Number),
})

export const DarajaErrorResponse = z.object({
  requestId: z.string().optional(),
  errorCode: z.string(),
  errorMessage: z.string(),
})

export const StkPushResponse = z.object({
  MerchantRequestID: z.string().min(1),
  CheckoutRequestID: z.string().min(1),
  ResponseCode: z.union([z.string(), z.number()]).transform(String),
  ResponseDescription: z.string(),
  CustomerMessage: z.string().optional(),
})

export const StkQueryResponse = z.object({
  ResponseCode: z.union([z.string(), z.number()]).transform(String),
  ResponseDescription: z.string(),
  MerchantRequestID: z.string(),
  CheckoutRequestID: z.string(),
  ResultCode: z.union([z.string(), z.number()]).transform(String),
  ResultDesc: z.string(),
})

const CallbackItem = z.object({
  Name: z.string(),
  Value: z.union([z.string(), z.number()]).optional(),
})

export const StkCallback = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().min(1),
      CheckoutRequestID: z.string().min(1),
      ResultCode: z.union([z.number(), z.string()]).transform(String),
      ResultDesc: z.string(),
      CallbackMetadata: z.object({ Item: z.array(CallbackItem) }).optional(),
    }),
  }),
})
export type StkCallback = z.infer<typeof StkCallback>

/** Validation and confirmation share this shape; validation leaves some fields empty. */
export const C2BNotification = z.object({
  TransactionType: z.string(),
  TransID: z.string().regex(/^[A-Z0-9]{10}$/),
  TransTime: z.union([z.string(), z.number()]),
  TransAmount: z.union([z.string(), z.number()]),
  BusinessShortCode: z.union([z.string(), z.number()]).transform(String),
  BillRefNumber: z.string().optional().default(''),
  InvoiceNumber: z.string().optional().default(''),
  OrgAccountBalance: z.union([z.string(), z.number()]).optional(),
  ThirdPartyTransID: z.string().optional().default(''),
  MSISDN: z.union([z.string(), z.number()]).transform(String).optional(),
  FirstName: z.string().optional().default(''),
  MiddleName: z.string().optional().default(''),
  LastName: z.string().optional().default(''),
})
export type C2BNotification = z.infer<typeof C2BNotification>

export const C2BRegisterResponse = z.object({
  // Spelled this way by Daraja.
  OriginatorCoversationID: z.string().optional(),
  ResponseCode: z.union([z.string(), z.number()]).transform(String),
  ResponseDescription: z.string(),
})

export const C2BSimulateResponse = C2BRegisterResponse
