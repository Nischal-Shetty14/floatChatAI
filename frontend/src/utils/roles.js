const CITIZEN_TABS = [
  'disaster-alerts',
  'emergency-sos',
  'shelter-resources',
  'offline-mesh',
  'family-safety',
  'dashboard',
  'about'
];

const OPERATOR_TABS = [
  ...CITIZEN_TABS,
  'rescue-command',
  'ml-anomaly',
  'incidents',
  'upload'
];

export const ROLE_LABELS = {
  user: 'Citizen',
  admin: 'Admin',
  warehouse_manager: 'Warehouse manager'
};

export function tabsForRole(role) {
  if (role === 'admin') return [...OPERATOR_TABS, 'sms-alerts', 'admin-portal'];
  if (role === 'warehouse_manager') return OPERATOR_TABS;
  return CITIZEN_TABS;
}
