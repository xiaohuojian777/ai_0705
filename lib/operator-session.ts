const EXAM_OPERATOR_NAME = "系统用户";

type AccountActionResult =
  | {
      success: true;
      username: string;
    }
  | {
      success: false;
      error: string;
      status: number;
    };

export function normalizeOperatorName(input: string | null | undefined) {
  return input?.trim() || EXAM_OPERATOR_NAME;
}

export async function authenticateUser(): Promise<AccountActionResult> {
  // 本次考试不包含登录模块。保留同名函数仅为兼容旧接口，始终进入系统用户。
  return {
    success: true,
    username: EXAM_OPERATOR_NAME,
  };
}

export async function registerUser(): Promise<AccountActionResult> {
  // 注册功能属于历史登录模块，考试模式不再开放真实注册。
  return {
    success: true,
    username: EXAM_OPERATOR_NAME,
  };
}

export async function isAuthenticated() {
  // 考试模式：万能导入直接可访问，避免非考试登录流程干扰验收。
  return true;
}

export async function getOperatorNameFromSession() {
  return EXAM_OPERATOR_NAME;
}

export async function getSessionUsername() {
  return EXAM_OPERATOR_NAME;
}

export async function createSession() {
  // 考试模式无需写入 cookie。
}

export async function clearSession() {
  // 考试模式无需清理 cookie。
}
