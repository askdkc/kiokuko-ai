// Negative fixtures started inside a test must not contribute evidence to its parent suite.
// The CLI test runner/reporters retain the directory; isolated test workers do not.
if (process.env.NODE_TEST_CONTEXT) for (const key of ['KIOKUKO_VERIFY_REPORT_DIR','KIOKUKO_VERIFY_COMPLETION_FILE','KIOKUKO_VERIFY_CHECK_ID','KIOKUKO_VERIFY_NONCE']) delete process.env[key];
