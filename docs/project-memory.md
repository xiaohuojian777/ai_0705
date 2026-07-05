# 项目记忆

## 项目概览

- 项目目录：`D:\codex\Vercel`
- GitHub：`git@github.com:raylxl/vercelProject.git`
- 本地地址：`http://localhost:3000`
- 线上地址：`https://vercelproject-roan-theta.vercel.app`
- 当前主分支：`main`
- 当前关键发布提交：
  - `2052528 Add login and registration flow`
  - `f9c7822 Refine dashboard UI and nested finance menu`

## 技术栈

- 前端：Next.js App Router + React 19
- 后端：Next.js Route Handlers
- 数据库：PostgreSQL
- ORM：Prisma 6
- 部署：Vercel

## 当前功能范围

- 费用类型维护后台已完成基础可用版本。
- 左侧菜单结构已按财务后台形式整理：
  - `财务管理`
  - `基础数据`
  - `费用类型维护`
- 费用类型页面已具备：
  - 列表查询
  - 分页
  - 每页条数切换
  - 新增
  - 编辑
  - 删除
  - 查看详情弹窗
  - 操作日志展示
- UI 已参考公司测试环境后台风格做过一轮调整。

## 登录与账号规则

- 管理员固定账号：
  - 用户名：`admin`
  - 密码：`1234`
- 普通账号支持前台注册并自动登录。
- 当前账号规则：
  - 账户名：任意字符，长度最多 `8` 位
  - 密码：仅允许数字，长度最多 `8` 位
- 登录态通过 cookie 维护。
- 未登录访问以下接口会返回 `401`：
  - `/api/session`
  - `/api/fee-types`
  - `/api/fee-types/[id]`
  - `/api/fee-type-operation-logs`

## 当前数据模型

- `UserAccount`
  - 注册账号表
  - `username` 最长 `8`
  - `passwordHash` 最长 `200`
- `FeeType`
  - 费用类型主表
- `FeeTypeOperationLog`
  - 费用类型操作日志表

## 关键文件

- [app/page.tsx](D:/codex/Vercel/app/page.tsx)
  - 首页入口，按登录态决定展示登录页还是业务页
- [app/fee-type-manager.tsx](D:/codex/Vercel/app/fee-type-manager.tsx)
  - 费用类型后台主界面
- [app/api/session/route.ts](D:/codex/Vercel/app/api/session/route.ts)
  - 登录、注册、退出登录接口
- [app/api/fee-types/route.ts](D:/codex/Vercel/app/api/fee-types/route.ts)
  - 费用类型列表、新增、删除接口
- [app/api/fee-types/[id]/route.ts](D:/codex/Vercel/app/api/fee-types/[id]/route.ts)
  - 费用类型编辑接口
- [app/api/fee-type-operation-logs/route.ts](D:/codex/Vercel/app/api/fee-type-operation-logs/route.ts)
  - 操作日志接口
- [lib/operator-session.ts](D:/codex/Vercel/lib/operator-session.ts)
  - 登录态、注册、密码哈希、cookie 逻辑
- [lib/account-rules.ts](D:/codex/Vercel/lib/account-rules.ts)
  - 账号长度与管理员常量
- [prisma/schema.prisma](D:/codex/Vercel/prisma/schema.prisma)
  - Prisma 模型定义
- [vercel.json](D:/codex/Vercel/vercel.json)
  - Vercel 构建命令

## 常用命令

```bash
npm run dev
npm run build
npx prisma generate
npx prisma migrate deploy
vercel --prod
```

## 发布约定

- Vercel 使用：
  - `prisma migrate deploy && next build`
- 推送 GitHub 时优先走 SSH。
- 这个环境里建议使用 `git.exe`，比直接在 PowerShell 管道里用 `git` 更稳。
- 发布后至少做两条线上检查：
  - 首页返回 `200`
  - `/api/session` 返回正常 JSON

## 已知操作经验

- 若本地 `prisma generate` 因 `query_engine-windows.dll.node` 被占用失败：
  - 先停掉本地 `next dev`
  - 再执行 `npx prisma generate`
  - 然后重新启动本地服务
- PowerShell 下执行需要 `DATABASE_URL` 的 Prisma 命令时，必要时要显式从 `.env.local` 注入环境变量。
- 如果只是改了 Prisma 类型而本地 dev 服务没重启，可能出现“数据库已迁移，但运行时仍按旧 schema 报错”的情况，重启本地服务即可。

## 后续建议

- 如果继续增强这个项目，优先顺序可以是：
  - 注册账号的管理页
  - 登录页错误提示与成功提示优化
  - 费用类型字段字典化
  - 更完整的线上验收清单
