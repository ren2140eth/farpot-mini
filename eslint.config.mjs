import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Foundry project. `npm run lint` takes no path, so without these it walks the
    // vendored solady/forge-std submodules and reports failures in code we do not own —
    // which made the lint gate unusable as a signal for our own changes.
    "contracts/lib/**",
    "contracts/out/**",
    "contracts/cache/**",
  ]),
]);

export default eslintConfig;
