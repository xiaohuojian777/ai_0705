export const BUSINESS_DOMAIN_OPTIONS = [
  { value: "运配", label: "运配" },
  { value: "寄取", label: "寄取" },
] as const;

export const QUOTE_TYPE_OPTIONS = [
  { value: "平台价格", label: "平台价格" },
  { value: "成本价格", label: "成本价格" },
  { value: "网点价格", label: "网点价格" },
  { value: "基础价格", label: "基础价格" },
  { value: "增值服务价格", label: "增值服务价格" },
] as const;

export const SYSTEM_USER_NAME = "系统用户";
export const OPERATOR_COOKIE_NAME = "fee_type_operator";
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const;
export const DEFAULT_PAGE_SIZE = 10;
export const OPERATION_LOG_TAKE = 10;

export type BusinessDomain = (typeof BUSINESS_DOMAIN_OPTIONS)[number]["value"];
export type QuoteType = (typeof QUOTE_TYPE_OPTIONS)[number]["value"];

export function isBusinessDomain(value: string): value is BusinessDomain {
  return BUSINESS_DOMAIN_OPTIONS.some((item) => item.value === value);
}

export function isQuoteType(value: string): value is QuoteType {
  return QUOTE_TYPE_OPTIONS.some((item) => item.value === value);
}
