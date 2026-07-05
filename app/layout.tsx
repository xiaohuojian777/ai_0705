import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "万能导入",
  description: "万能导入，支持运单管理、规则管理与历史运单查询。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
