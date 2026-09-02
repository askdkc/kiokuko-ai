# Embedding security

The local-small preset fixes the repository, full revision, required files,
sizes, and SHA-256 values. Arbitrary repositories, URLs, paths, extensions,
and remote code are not accepted. Files are verified before model loading;
staging is private and final installation is atomic.

Status, doctor, progress, and errors do not include memory text, query text,
credentials, redirect URLs, or absolute model paths. Embedding configuration is
limited to the pinned local-small preset; unsupported provider and endpoint
variables are ignored and never become runtime configuration.
