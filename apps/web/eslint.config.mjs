import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // pi-web v0.8.6 uses intentional ref-backed callbacks that the newer
      // compiler lint cannot preserve; keep the pinned upstream behavior.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default eslintConfig;
