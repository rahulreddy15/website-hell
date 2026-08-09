# Offline analysis

This directory is the dependency boundary for reproducible, read-only notebooks that may use
the scientific Python stack. The production server does not import anything here. Open the
SQLite database in read-only mode (`file:/path/to/db?mode=ro&immutable=1`, `uri=True`) and do
not write derived lag bins or features back to it. V1's executable synthetic acceptance fixture
and lagged exposure checks live in `../smoke_test.py`.
