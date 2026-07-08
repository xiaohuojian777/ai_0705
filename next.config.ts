import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/**/*": [
      "./prisma/**/*",
      "./node_modules/.prisma/**/*",
      "./node_modules/@prisma/client/**/*",
    ],
  },
};

export default nextConfig;
