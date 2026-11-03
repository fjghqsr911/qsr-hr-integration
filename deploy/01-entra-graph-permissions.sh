#!/usr/bin/env bash
# =============================================================================
# hrint-api - Microsoft Graph application permissions for the Entra sync.
# Run in Azure Cloud Shell (Bash) as a Global Administrator or Privileged Role Administrator. Safe to re-run.
#
# Grants, to the SYSTEM-ASSIGNED managed identity of Function App func-hrint-prod-cc, these Graph app roles
# (application permissions; no user, no secret: the Function App gets its token from the identity endpoint):
#   User.Read.All                    snapshot users (upn, mail, jobTitle, department, officeLocation, accountEnabled ...)
#   GroupMember.Read.All             snapshot groups and the members of managed groups
#   User.ReadWrite.All               apply accepted attribute proposals (jobTitle, department, officeLocation)
#   User.EnableDisableAccount.All    apply accepted disable / enable proposals
#   GroupMember.ReadWrite.All        apply accepted group proposals and manual group members
# NOT granted on purpose: Directory.ReadWrite.All, Group.ReadWrite.All, RoleManagement.* (role-assignable groups are
# never managed by hrint-api). Users holding a directory role still cannot be changed (Graph answers 403 -> proposal failed).
#
# Prints the list and asks y/N before writing. Assignments are made through Graph appRoleAssignedTo on the
# Microsoft Graph service principal, which is what the portal does for managed identities.
# =============================================================================
set -euo pipefail

FUNC_RG="${FUNC_RG:-rg-hrint-prod-cc}"
FUNC_APP="${FUNC_APP:-func-hrint-prod-cc}"
GRAPH="https://graph.microsoft.com/v1.0"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"      # Microsoft Graph (same in every tenant)
ROLES=(User.Read.All GroupMember.Read.All User.ReadWrite.All User.EnableDisableAccount.All GroupMember.ReadWrite.All)

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Tenant: $TENANT_ID"

# 1. The Function App identity (system-assigned)
MI_PRINCIPAL_ID=$(az functionapp identity show -g "$FUNC_RG" -n "$FUNC_APP" --query principalId -o tsv 2>/dev/null || true)
if [ -z "$MI_PRINCIPAL_ID" ] || [ "$MI_PRINCIPAL_ID" = "None" ]; then
  echo "ERROR: $FUNC_APP has no system-assigned identity. Enable it: Function App -> Identity -> System assigned -> On (the SQL access already uses it)."
  exit 1
fi
echo "Function App $FUNC_APP identity: $MI_PRINCIPAL_ID"

# 2. Microsoft Graph service principal in this tenant, with its app roles
GRAPH_SP=$(az rest --method GET --uri "$GRAPH/servicePrincipals?\$filter=appId%20eq%20'$GRAPH_APP_ID'&\$select=id,appRoles")
GRAPH_SP_ID=$(echo "$GRAPH_SP" | jq -r '.value[0].id')
if [ -z "$GRAPH_SP_ID" ] || [ "$GRAPH_SP_ID" = "null" ]; then echo "ERROR: Microsoft Graph service principal not found"; exit 1; fi

# 3. What is already assigned
EXISTING=$(az rest --method GET --uri "$GRAPH/servicePrincipals/$MI_PRINCIPAL_ID/appRoleAssignments?\$top=999" \
  | jq -c --arg sp "$GRAPH_SP_ID" '[.value[] | select(.resourceId==$sp) | .appRoleId]')

echo
echo "Graph application permissions for $FUNC_APP:"
TODO=()
for role in "${ROLES[@]}"; do
  ROLE_ID=$(echo "$GRAPH_SP" | jq -r --arg v "$role" '.value[0].appRoles[] | select(.value==$v and (.allowedMemberTypes | index("Application"))) | .id' | head -1)
  if [ -z "$ROLE_ID" ]; then echo "  ?? $role (not found on the Graph service principal)"; continue; fi
  if echo "$EXISTING" | jq -e --arg id "$ROLE_ID" 'index($id)' >/dev/null; then
    echo "  ok $role (already granted)"
  else
    echo "  +  $role"
    TODO+=("$role=$ROLE_ID")
  fi
done

if [ ${#TODO[@]} -eq 0 ]; then echo; echo "Nothing to do."; exit 0; fi
echo
read -r -p "Grant the ${#TODO[@]} permission(s) marked + to $FUNC_APP? [y/N] " ANSWER
case "$ANSWER" in y|Y|yes|YES) ;; *) echo "Aborted; nothing changed."; exit 0 ;; esac

# 4. Assign (needs AppRoleAssignment.ReadWrite.All or a Global / Privileged Role administrator)
for pair in "${TODO[@]}"; do
  role="${pair%%=*}"; ROLE_ID="${pair#*=}"
  az rest --method POST --uri "$GRAPH/servicePrincipals/$GRAPH_SP_ID/appRoleAssignedTo" --headers "Content-Type=application/json" \
    --body "{\"principalId\":\"$MI_PRINCIPAL_ID\",\"resourceId\":\"$GRAPH_SP_ID\",\"appRoleId\":\"$ROLE_ID\"}" -o none
  echo "  granted $role"
done

echo
echo "Done. The identity token is cached by Entra for up to 24 h: a permission granted now may take a while to show up."
echo "Next: set ENTRA_SYNC_ENABLED=true on the Function App (snapshot + proposals, no writes), run POST /api/hub/entra/sync,"
echo "check the entra row on the Diagnostics tab, then bash deploy/02-entra-admin-role.sh for the Entra.Admin role."
echo "ENTRA_WRITE_ENABLED stays unset until the first proposals have been reviewed."
