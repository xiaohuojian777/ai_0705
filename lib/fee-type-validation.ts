import {
  BUSINESS_DOMAIN_OPTIONS,
  QUOTE_TYPE_OPTIONS,
  isBusinessDomain,
  isQuoteType,
} from "@/lib/fee-type-config";

export type FeeTypePayload = {
  feeCode: string;
  feeName: string;
  businessDomain: string;
  quoteTypes: string[];
  note: string;
};

export type ValidationResult =
  | {
      success: true;
      data: {
        feeCode: string;
        feeName: string;
        businessDomain: string;
        quoteTypes: string[];
        note: string | null;
      };
    }
  | {
      success: false;
      error: string;
    };

export function validateFeeTypePayload(payload: FeeTypePayload): ValidationResult {
  const feeCode = payload.feeCode.trim();
  const feeName = payload.feeName.trim();
  const note = payload.note.trim();
  const quoteTypes = Array.from(new Set(payload.quoteTypes));

  if (!/^\d{1,8}$/.test(feeCode)) {
    return {
      success: false,
      error: "费用编号必填，且只能输入 1 到 8 位数字。",
    };
  }

  if (!feeName || feeName.length > 32) {
    return {
      success: false,
      error: "费用名称必填，且长度不能超过 32 个字符。",
    };
  }

  if (!isBusinessDomain(payload.businessDomain)) {
    return {
      success: false,
      error: `所属业务域必填，取值范围为：${BUSINESS_DOMAIN_OPTIONS.map((item) => item.label).join("、")}。`,
    };
  }

  if (!quoteTypes.every(isQuoteType)) {
    return {
      success: false,
      error: `所属报价取值不合法，支持：${QUOTE_TYPE_OPTIONS.map((item) => item.label).join("、")}。`,
    };
  }

  if (note.length > 256) {
    return {
      success: false,
      error: "备注长度不能超过 256 个字符。",
    };
  }

  return {
    success: true,
    data: {
      feeCode,
      feeName,
      businessDomain: payload.businessDomain,
      quoteTypes,
      note: note || null,
    },
  };
}
