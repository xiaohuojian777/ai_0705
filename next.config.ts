import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel serverless 函数需要显式包含 Prisma 引擎文件
  outputFileTracingIncludes: {
    "/*": ["./node_modules/.prisma/client/**/*"],
  },
};

export default nextConfig;
