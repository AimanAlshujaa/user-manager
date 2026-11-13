export type Role = 'SUPER_ADMIN' | 'RESELLER';

export type CharsetType = 'NUMERIC' | 'ALPHANUMERIC_UPPER' | 'ALPHANUMERIC_MIXED';
export type VoucherType = 'PIN_ONLY' | 'USER_PASS';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

export interface GenerateBatchDTO {
  profileId: number;
  quantity: number;
  resellerId?: number; // Super Admin can specify target reseller; Reseller uses own ID
  voucherType: VoucherType;
  prefix?: string;
  codeLength: number; // e.g., 6 to 16
  charsetType: CharsetType;
  notes?: string;
}

export interface GeneratedVoucherCard {
  username: string;
  cleartextPassword: string;
  serialNumber: string;
}

export interface ProfileDTO {
  name: string; // FreeRADIUS groupname (ASCII slug, e.g., "plan_2m_1day")
  displayName: string; // Friendly Arabic name, e.g., "باقة 2 ميجا - يوم كامل"
  price: number;
  costPrice: number;
  speedLimit: string; // e.g., "2M/2M" or "4M/4M 6M/6M 1M/1M 8/8"
  timeLimit?: number | null; // Seconds (Session-Timeout / Max-All-Session)
  dataLimitMb?: number | null; // MB
  validityDays?: number | null;
  simultaneousUse: number;
  portLimit: number;
}

export interface ActiveSessionRow {
  radacctid: number;
  acctsessionid: string;
  acctuniqueid: string;
  username: string;
  nasipaddress: string;
  nasportid: string;
  acctstarttime: string;
  acctupdatetime: string;
  acctsessiontime: number; // Uptime in seconds
  acctinputoctets: number; // Upload bytes (from client perspective in MikroTik)
  acctoutputoctets: number; // Download bytes
  calledstationid: string; // Hotspot Server Name / MAC
  callingstationid: string; // Client MAC Address
  framedipaddress: string; // Client IPv4 Address
}
