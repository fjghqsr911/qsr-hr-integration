#!/usr/bin/env bash
# =============================================================================
# hrint-api - app role Entra.Admin (accept / reject / apply Entra proposals, group members, rules, links).
# Run in Azure Cloud Shell (Bash). Safe to re-run: existing roles and ids are kept, Entra.Admin is appended once.
#
#   ENTRA_ADMINS="fraser@qsrgroup.ca leah@qsrgroup.ca" bash deploy/02-entra-admin-role.sh
#
# Does:
#   1. hrint-api app registration (app id e624948e-39a1-4657-9fb5-9f652c3a2a53): read appRoles, append
#      Entra.Admin (allowed member type User) if missing, PATCH the full list back
#   2. hrint-api enterprise app: assign Entra.Admin to every UPN in ENTRA_ADMINS (you are always added)
# Entra.Admin implies Summary.Read inside hrint-api; the monitor also needs the user to hold a monitor role.
# =============================================================================
set -euo pipefail

HRINT_API_APP_ID="${HRINT_API_APP_ID:-e624948e-39a1-4657-9fb5-9f652c3a2a53}"
ENTRA_ADMINS="${ENTRA_ADMINS:-}"
GRAPH="https://graph.microsoft.com/v1.0"
ROLE_VALUE="Entra.Admin"

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Tenant: $TENANT_ID"

# 1. Registration: appRoles, keeping every existing role and id
OBJ_ID=$(az ad app show --id "$HRINT_API_APP_ID" --query id -o tsv)
CURRENT=$(az rest --method GET --uri "$GRAPH/applications/$OBJ_ID?\$select=appRoles,displayName")
echo "Registration: $(echo "$CURRENT" | jq -r .displayName) ($HRINT_API_APP_ID)"
ROLE_ID=$(echo "$CURRENT" | jq -r --arg v "$ROLE_VALUE" '.appRoles[]? | select(.value==$v) | .id' | head -1)
if [ -n "$ROLE_ID" ]; then
  echo "App role $ROLE_VALUE exists ($ROLE_ID)"
else
  ROLE_ID=$(uuidgen)
  ROLES=$(echo "$CURRENT" | jq -c --arg id "$ROLE_ID" --arg v "$ROLE_VALUE" '(.appRoles // []) + [{
    "id": $id, "value": $v, "displayName": "Entra Admin",
    "description": "Accept, reject and apply Entra ID proposals (job title, department, office, sign-in), manage group members, rules and links. Implies Summary.Read.",
    "allowedMemberTypes": ["User"], "isEnabled": true }]')
  az rest --method PATCH --uri "$GRAPH/applications/$OBJ_ID" --headers "Content-Type=application/json" --body "{\"appRoles\": $ROLES}" -o none
  echo "App role $ROLE_VALUE added ($ROLE_ID); existing roles kept: $(echo "$CURRENT" | jq -r '[.appRoles[]?.value] | join(", ")')"
  sleep 10
fi

# 2. Enterprise app assignments
SP_ID=$(az ad sp list --filter "appId eq '$HRINT_API_APP_ID'" --query "[0].id" -o tsv)
if [ -z "$SP_ID" ]; then echo "ERROR: enterprise app for $HRINT_API_APP_ID not found"; exit 1; fi

assign_role () {  # upn role_id role_name
  local USER_ID; USER_ID=$(az ad user show --id "$1" --query id -o tsv 2>/dev/null || true)
  if [ -z "$USER_ID" ]; then echo "  skip $1: user not found"; return; fi
  local EXISTING; EXISTING=$(az rest --method GET --uri "$GRAPH/servicePrincipals/$SP_ID/appRoleAssignedTo?\$top=999" \
    --query "value[?principalId=='$USER_ID' && appRoleId=='$2'] | length(@)" -o tsv)
  if [ "$EXISTING" = "0" ]; then
    az rest --method POST --uri "$GRAPH/servicePrincipals/$SP_ID/appRoleAssignedTo" --headers "Content-Type=application/json" \
      --body "{\"principalId\":\"$USER_ID\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"$2\"}" -o none
    echo "  $1 -> $3"
  else
    echo "  $1 already has $3"
  fi
}
ME=$(az ad signed-in-user show --query userPrincipalName -o tsv)
echo "Role assignments on hrint-api:"
assign_role "$ME" "$ROLE_ID" "$ROLE_VALUE"
for u in $ENTRA_ADMINS; do assign_role "$u" "$ROLE_ID" "$ROLE_VALUE"; done

echo
echo "Done. Users sign out and back in to the monitor to pick up the role (GET /api/me on hrint-api lists it)."
echo "The monitor shows the Entra admin buttons for callers whose hrint-api roles include $ROLE_VALUE."
