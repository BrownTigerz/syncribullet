export interface SimklPreAuth {
  /** OAuth 2.0 device-flow polling credential (never shown to the user). */
  device_code: string;
  /** 8-character code the user approves on simkl.com/pin. */
  user_code?: string;
  client_id?: string;
}
