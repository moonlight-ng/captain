-- Run as the Workflow login immediately after bootstrap. This moves every
-- object created by that login onto the non-login group role so credentials
-- can be rotated without orphaning Workflow state.
reassign owned by captain_workflow_login to captain_workflow;
