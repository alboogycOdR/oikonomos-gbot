export {
  SAFE_VALUE,
  GENERIC_ERROR_CODE,
  RegisteredError,
  defineRegisteredError,
  lookupErrorDefinition,
  emitErrorTags,
  type ErrorDefinition,
  type EmittedErrorTags,
  type RegisteredErrorConstructor,
} from "./registry.js";

export {
  mintBrokerFailure,
  mintAuditUnavailable,
  mintHarnessFactoryError,
  mintL2ConfigError,
  mintMcpConfigError,
  mintSubagentPolicyError,
  mintAuditWriteError,
} from "./seeds.js";
