import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/": ["./lib/dev.db"],
  },
};

export default nextConfig;
