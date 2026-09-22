#!/usr/bin/env bash
# AMG is no longer in Terraform. g-ede3f6a694 is DELETION_FAILED because
# cohort SSO denies sso:DeleteManagedApplicationInstance. Importing it
# makes Release fail on DescribeWorkspaceConfiguration. Grafana Cloud
# (punywaxwing1700) is the human login. JSON files stay the contract.
set -euo pipefail
echo "AMG is not managed; Grafana Cloud is the login"
exit 0
