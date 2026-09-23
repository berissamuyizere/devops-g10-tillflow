#!/usr/bin/env bash
# AMG is no longer in Terraform. Leftover g-ede3f6a694 was DELETION_FAILED because
# cohort SSO denies sso:DeleteManagedApplicationInstance. Importing it made CI/Release
# fail on DescribeWorkspaceConfiguration. Grafana Cloud (punywaxwing1700) is the login.
# JSON files under infra/grafana/ stay the contract.
set -euo pipefail
echo "AMG is not managed; Grafana Cloud is the login"
exit 0
