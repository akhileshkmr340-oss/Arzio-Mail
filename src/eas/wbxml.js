// WBXML encoder and decoder for Exchange ActiveSync (MS-ASWBXML).
//
// A document is a tree of nodes: { tag: 'AirSync:Sync', children: [...] },
// { tag: 'AirSync:SyncKey', text: '1' } or { tag: 'ComposeMail:Mime', opaque: Buffer }.
// Build them with E('Page:Tag', value) where value is a string, a Buffer,
// an array of child nodes, or nothing for an empty element.

const PAGES = {
  0: ['AirSync', { 5: 'Sync', 6: 'Responses', 7: 'Add', 8: 'Change', 9: 'Delete', 10: 'Fetch', 11: 'SyncKey', 12: 'ClientId', 13: 'ServerId', 14: 'Status', 15: 'Collection', 16: 'Class', 18: 'CollectionId', 19: 'GetChanges', 20: 'MoreAvailable', 21: 'WindowSize', 22: 'Commands', 23: 'Options', 24: 'FilterType', 27: 'Conflict', 28: 'Collections', 29: 'ApplicationData', 30: 'DeletesAsMoves', 32: 'Supported', 33: 'SoftDelete', 34: 'MIMESupport', 35: 'MIMETruncation', 36: 'Wait', 37: 'Limit', 38: 'Partial', 39: 'ConversationMode', 40: 'MaxItems', 41: 'HeartbeatInterval' }],
  1: ['Contacts', { 5: 'Anniversary', 6: 'AssistantName', 7: 'AssistantPhoneNumber', 8: 'Birthday', 9: 'Body', 10: 'BodySize', 11: 'BodyTruncated', 12: 'Business2PhoneNumber', 13: 'BusinessAddressCity', 14: 'BusinessAddressCountry', 15: 'BusinessAddressPostalCode', 16: 'BusinessAddressState', 17: 'BusinessAddressStreet', 18: 'BusinessFaxNumber', 19: 'BusinessPhoneNumber', 20: 'CarPhoneNumber', 21: 'Categories', 22: 'Category', 23: 'Children', 24: 'Child', 25: 'CompanyName', 26: 'Department', 27: 'Email1Address', 28: 'Email2Address', 29: 'Email3Address', 30: 'FileAs', 31: 'FirstName', 32: 'Home2PhoneNumber', 33: 'HomeAddressCity', 34: 'HomeAddressCountry', 35: 'HomeAddressPostalCode', 36: 'HomeAddressState', 37: 'HomeAddressStreet', 38: 'HomeFaxNumber', 39: 'HomePhoneNumber', 40: 'JobTitle', 41: 'LastName', 42: 'MiddleName', 43: 'MobilePhoneNumber', 44: 'OfficeLocation', 45: 'OtherAddressCity', 46: 'OtherAddressCountry', 47: 'OtherAddressPostalCode', 48: 'OtherAddressState', 49: 'OtherAddressStreet', 50: 'PagerNumber', 51: 'RadioPhoneNumber', 52: 'Spouse', 53: 'Suffix', 54: 'Title', 55: 'WebPage', 56: 'YomiCompanyName', 57: 'YomiFirstName', 58: 'YomiLastName', 59: 'CompressedRTF', 60: 'Picture', 61: 'Alias', 62: 'WeightedRank' }],
  2: ['Email', { 5: 'Attachment', 6: 'Attachments', 7: 'AttName', 8: 'AttSize', 9: 'Att0Id', 10: 'AttMethod', 11: 'AttRemoved', 12: 'Body', 13: 'BodySize', 14: 'BodyTruncated', 15: 'DateReceived', 16: 'DisplayName', 17: 'DisplayTo', 18: 'Importance', 19: 'MessageClass', 20: 'Subject', 21: 'Read', 22: 'To', 23: 'Cc', 24: 'From', 25: 'ReplyTo', 26: 'AllDayEvent', 27: 'Categories', 28: 'Category', 29: 'DTStamp', 30: 'EndTime', 31: 'InstanceType', 32: 'BusyStatus', 33: 'Location', 34: 'MeetingRequest', 35: 'Organizer', 36: 'RecurrenceId', 37: 'Reminder', 38: 'ResponseRequested', 39: 'Recurrences', 40: 'Recurrence', 41: 'Recurrence_Type', 42: 'Recurrence_Until', 43: 'Recurrence_Occurrences', 44: 'Recurrence_Interval', 45: 'Recurrence_DayOfWeek', 46: 'Recurrence_DayOfMonth', 47: 'Recurrence_WeekOfMonth', 48: 'Recurrence_MonthOfYear', 49: 'StartTime', 50: 'Sensitivity', 51: 'TimeZone', 52: 'GlobalObjId', 53: 'ThreadTopic', 54: 'MIMEData', 55: 'MIMETruncated', 56: 'MIMESize', 57: 'InternetCPID', 58: 'Flag', 59: 'FlagStatus', 60: 'ContentClass', 61: 'FlagType', 62: 'CompleteTime', 63: 'DisallowNewTimeProposal' }],
  4: ['Calendar', { 5: 'TimeZone', 6: 'AllDayEvent', 7: 'Attendees', 8: 'Attendee', 9: 'Email', 10: 'Name', 11: 'Body', 12: 'BodyTruncated', 13: 'BusyStatus', 14: 'Categories', 15: 'Category', 17: 'DTStamp', 18: 'EndTime', 19: 'Exception', 20: 'Exceptions', 21: 'Deleted', 22: 'ExceptionStartTime', 23: 'Location', 24: 'MeetingStatus', 25: 'OrganizerEmail', 26: 'OrganizerName', 27: 'Recurrence', 28: 'Type', 29: 'Until', 30: 'Occurrences', 31: 'Interval', 32: 'DayOfWeek', 33: 'DayOfMonth', 34: 'WeekOfMonth', 35: 'MonthOfYear', 36: 'Reminder', 37: 'Sensitivity', 38: 'Subject', 39: 'StartTime', 40: 'UID', 41: 'AttendeeStatus', 42: 'AttendeeType', 51: 'DisallowNewTimeProposal', 52: 'ResponseRequested', 53: 'AppointmentReplyTime', 54: 'ResponseType', 55: 'CalendarType', 56: 'IsLeapMonth', 57: 'FirstDayOfWeek', 58: 'OnlineMeetingConfLink', 59: 'OnlineMeetingExternalLink' }],
  5: ['Move', { 5: 'MoveItems', 6: 'Move', 7: 'SrcMsgId', 8: 'SrcFldId', 9: 'DstFldId', 10: 'Response', 11: 'Status', 12: 'DstMsgId' }],
  6: ['GetItemEstimate', { 5: 'GetItemEstimate', 6: 'Version', 7: 'Collections', 8: 'Collection', 9: 'Class', 10: 'CollectionId', 11: 'DateTime', 12: 'Estimate', 13: 'Response', 14: 'Status' }],
  7: ['FolderHierarchy', { 7: 'DisplayName', 8: 'ServerId', 9: 'ParentId', 10: 'Type', 12: 'Status', 14: 'Changes', 15: 'Add', 16: 'Delete', 17: 'Update', 18: 'SyncKey', 19: 'FolderCreate', 20: 'FolderDelete', 21: 'FolderUpdate', 22: 'FolderSync', 23: 'Count' }],
  8: ['MeetingResponse', { 5: 'CalendarId', 6: 'CollectionId', 7: 'MeetingResponse', 8: 'RequestId', 9: 'Request', 10: 'Result', 11: 'Status', 12: 'UserResponse', 14: 'InstanceId' }],
  9: ['Tasks', { 5: 'Body', 6: 'BodySize', 7: 'BodyTruncated', 8: 'Categories', 9: 'Category', 10: 'Complete', 11: 'DateCompleted', 12: 'DueDate', 13: 'UtcDueDate', 14: 'Importance', 15: 'Recurrence', 16: 'Type', 17: 'Start', 18: 'Until', 19: 'Occurrences', 20: 'Interval', 21: 'DayOfMonth', 22: 'DayOfWeek', 23: 'WeekOfMonth', 24: 'MonthOfYear', 25: 'Regenerate', 26: 'DeadOccur', 27: 'ReminderSet', 28: 'ReminderTime', 29: 'Sensitivity', 30: 'StartDate', 31: 'UtcStartDate', 32: 'Subject', 34: 'OrdinalDate', 35: 'SubOrdinalDate', 36: 'CalendarType', 37: 'IsLeapMonth', 38: 'FirstDayOfWeek' }],
  13: ['Ping', { 5: 'Ping', 6: 'AutdState', 7: 'Status', 8: 'HeartbeatInterval', 9: 'Folders', 10: 'Folder', 11: 'Id', 12: 'Class', 13: 'MaxFolders' }],
  14: ['Provision', { 5: 'Provision', 6: 'Policies', 7: 'Policy', 8: 'PolicyType', 9: 'PolicyKey', 10: 'Data', 11: 'Status', 12: 'RemoteWipe', 13: 'EASProvisionDoc', 14: 'DevicePasswordEnabled', 15: 'AlphanumericDevicePasswordRequired', 16: 'RequireStorageCardEncryption', 17: 'PasswordRecoveryEnabled', 19: 'AttachmentsEnabled', 20: 'MinDevicePasswordLength', 21: 'MaxInactivityTimeDeviceLock', 22: 'MaxDevicePasswordFailedAttempts', 23: 'MaxAttachmentSize', 24: 'AllowSimpleDevicePassword', 25: 'DevicePasswordExpiration', 26: 'DevicePasswordHistory', 27: 'AllowStorageCard', 28: 'AllowCamera', 29: 'RequireDeviceEncryption', 30: 'AllowUnsignedApplications', 31: 'AllowUnsignedInstallationPackages', 32: 'MinDevicePasswordComplexCharacters', 33: 'AllowWiFi', 34: 'AllowTextMessaging', 35: 'AllowPOPIMAPEmail', 36: 'AllowBluetooth', 37: 'AllowIrDA', 38: 'RequireManualSyncWhenRoaming', 39: 'AllowDesktopSync', 40: 'MaxCalendarAgeFilter', 41: 'AllowHTMLEmail', 42: 'MaxEmailAgeFilter', 43: 'MaxEmailBodyTruncationSize', 44: 'MaxEmailHTMLBodyTruncationSize', 45: 'RequireSignedSMIMEMessages', 46: 'RequireEncryptedSMIMEMessages', 47: 'RequireSignedSMIMEAlgorithm', 48: 'RequireEncryptionSMIMEAlgorithm', 49: 'AllowSMIMEEncryptionAlgorithmNegotiation', 50: 'AllowSMIMESoftCerts', 51: 'AllowBrowser', 52: 'AllowConsumerEmail', 53: 'AllowRemoteDesktop', 54: 'AllowInternetSharing', 55: 'UnapprovedInROMApplicationList', 56: 'ApplicationName', 57: 'ApprovedApplicationList', 58: 'Hash', 59: 'AccountOnlyRemoteWipe' }],
  15: ['Search', { 5: 'Search', 7: 'Store', 8: 'Name', 9: 'Query', 10: 'Options', 11: 'Range', 12: 'Status', 13: 'Response', 14: 'Result', 15: 'Properties', 16: 'Total', 17: 'EqualTo', 18: 'Value', 19: 'And', 20: 'Or', 21: 'FreeText', 23: 'DeepTraversal', 24: 'LongId', 25: 'RebuildResults', 26: 'LessThan', 27: 'GreaterThan', 30: 'UserName', 31: 'Password', 32: 'ConversationId', 33: 'Picture', 34: 'MaxSize', 35: 'MaxPictures' }],
  16: ['GAL', { 5: 'DisplayName', 6: 'Phone', 7: 'Office', 8: 'Title', 9: 'Company', 10: 'Alias', 11: 'FirstName', 12: 'LastName', 13: 'HomePhone', 14: 'MobilePhone', 15: 'EmailAddress', 16: 'Picture', 17: 'Status', 18: 'Data' }],
  17: ['AirSyncBase', { 5: 'BodyPreference', 6: 'Type', 7: 'TruncationSize', 8: 'AllOrNone', 10: 'Body', 11: 'Data', 12: 'EstimatedDataSize', 13: 'Truncated', 14: 'Attachments', 15: 'Attachment', 16: 'DisplayName', 17: 'FileReference', 18: 'Method', 19: 'ContentId', 20: 'ContentLocation', 21: 'IsInline', 22: 'NativeBodyType', 23: 'ContentType', 24: 'Preview', 25: 'BodyPartPreference', 26: 'BodyPart', 27: 'Status' }],
  18: ['Settings', { 5: 'Settings', 6: 'Status', 7: 'Get', 8: 'Set', 9: 'Oof', 10: 'OofState', 11: 'StartTime', 12: 'EndTime', 13: 'OofMessage', 14: 'AppliesToInternal', 15: 'AppliesToExternalKnown', 16: 'AppliesToExternalUnknown', 17: 'Enabled', 18: 'ReplyMessage', 19: 'BodyType', 20: 'DevicePassword', 21: 'Password', 22: 'DeviceInformation', 23: 'Model', 24: 'IMEI', 25: 'FriendlyName', 26: 'OS', 27: 'OSLanguage', 28: 'PhoneNumber', 29: 'UserInformation', 30: 'EmailAddresses', 31: 'SmtpAddress', 32: 'UserAgent', 33: 'EnableOutboundSMS', 34: 'MobileOperator', 35: 'PrimarySmtpAddress', 36: 'Accounts', 37: 'Account', 38: 'AccountId', 39: 'AccountName', 40: 'UserDisplayName', 41: 'SendDisabled', 43: 'RightsManagementInformation' }],
  20: ['ItemOperations', { 5: 'ItemOperations', 6: 'Fetch', 7: 'Store', 8: 'Options', 9: 'Range', 10: 'Total', 11: 'Properties', 12: 'Data', 13: 'Status', 14: 'Response', 15: 'Version', 16: 'Schema', 17: 'Part', 18: 'EmptyFolderContents', 19: 'DeleteSubFolders', 20: 'UserName', 21: 'Password', 22: 'Move', 23: 'DstFldId', 24: 'ConversationId', 25: 'MoveAlways' }],
  21: ['ComposeMail', { 5: 'SendMail', 6: 'SmartForward', 7: 'SmartReply', 8: 'SaveInSentItems', 9: 'ReplaceMime', 11: 'Source', 12: 'FolderId', 13: 'ItemId', 14: 'LongId', 15: 'InstanceId', 16: 'Mime', 17: 'ClientId', 18: 'Status', 19: 'AccountId' }],
  22: ['Email2', { 5: 'UmCallerID', 6: 'UmUserNotes', 7: 'UmAttDuration', 8: 'UmAttOrder', 9: 'ConversationId', 10: 'ConversationIndex', 11: 'LastVerbExecuted', 12: 'LastVerbExecutionTime', 13: 'ReceivedAsBcc', 14: 'Sender', 15: 'CalendarType', 16: 'IsLeapMonth', 17: 'AccountId', 18: 'FirstDayOfWeek', 19: 'MeetingMessageType' }],
};
export { PAGES };

const TOKENS = new Map(); // 'Page:Tag' -> [page, token]
for (const [page, [ns, tags]] of Object.entries(PAGES)) for (const [tok, name] of Object.entries(tags)) TOKENS.set(`${ns}:${name}`, [Number(page), Number(tok)]);

const SWITCH_PAGE = 0x00, END = 0x01, STR_I = 0x03, OPAQUE = 0xc3;

/** Builds a node. value: string | number | Buffer | node[] | undefined */
export function E(tag, value) {
  if (!TOKENS.has(tag)) throw new Error(`Unknown WBXML tag ${tag}`);
  if (value === undefined || value === null) return { tag };
  if (Buffer.isBuffer(value)) return { tag, opaque: value };
  if (Array.isArray(value)) return { tag, children: value.filter(Boolean) };
  return { tag, text: String(value) };
}

function mbUint(n) {
  const out = [n & 0x7f];
  while ((n >>>= 7) > 0) out.unshift(0x80 | (n & 0x7f));
  return out;
}

export function encode(root) {
  const parts = [Buffer.from([0x03, 0x01, 0x6a, 0x00])];
  let page = 0;
  const walk = (n) => {
    const [p, tok] = TOKENS.get(n.tag);
    if (p !== page) { parts.push(Buffer.from([SWITCH_PAGE, p])); page = p; }
    const hasContent = n.text !== undefined || n.opaque || n.children?.length;
    parts.push(Buffer.from([tok | (hasContent ? 0x40 : 0)]));
    if (!hasContent) return;
    if (n.text !== undefined) parts.push(Buffer.from([STR_I]), Buffer.from(n.text.replace(/\0/g, ''), 'utf8'), Buffer.from([0]));
    else if (n.opaque) parts.push(Buffer.from([OPAQUE, ...mbUint(n.opaque.length)]), n.opaque);
    else for (const c of n.children) walk(c);
    parts.push(Buffer.from([END]));
  };
  walk(root);
  return Buffer.concat(parts);
}

export function decode(buf) {
  if (!buf?.length) return null;
  let i = 0;
  const byte = () => { if (i >= buf.length) throw new Error('Truncated WBXML'); return buf[i++]; };
  const mb = () => { let n = 0, b; do { b = byte(); n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
  byte(); mb(); mb(); // version, public id, charset
  const strtbl = mb(); i += strtbl;
  let page = 0;
  const readNode = (first) => {
    let t = first;
    while (t === SWITCH_PAGE) { page = byte(); t = byte(); }
    const ns = PAGES[page]?.[0] || `Page${page}`;
    const name = PAGES[page]?.[1][t & 0x3f] || `Tag${t & 0x3f}`;
    const node = { tag: `${ns}:${name}` };
    if (!(t & 0x40)) return node;
    const children = []; let text = null; let opaque = null;
    for (;;) {
      const b = byte();
      if (b === END) break;
      if (b === STR_I) {
        const s = i; while (buf[i] !== 0) { if (i >= buf.length) throw new Error('Truncated WBXML'); i++; }
        text = (text || '') + buf.subarray(s, i).toString('utf8'); i++;
      } else if (b === OPAQUE) {
        const len = mb(); opaque = buf.subarray(i, i + len); i += len;
      } else if (b === 0x83) { mb(); // STR_T (string table): not used by ActiveSync clients
      } else children.push(readNode(b));
    }
    if (children.length) node.children = children;
    else if (opaque) node.opaque = Buffer.from(opaque);
    else if (text !== null) node.text = text;
    else node.children = [];
    return node;
  };
  return readNode(byte());
}

// ------------------------------------------------------------ reading helpers
export const kids = (n, tag) => (n?.children || []).filter((c) => !tag || c.tag === tag);
export const child = (n, tag) => (n?.children || []).find((c) => c.tag === tag);
export const textOf = (n, tag) => { const c = tag ? child(n, tag) : n; return c ? (c.text ?? (c.opaque ? c.opaque.toString('utf8') : '')) : undefined; };

/** Readable XML, for logs and tests. */
export function toXml(n, ind = '') {
  if (!n) return '';
  if (n.text !== undefined) return `${ind}<${n.tag}>${n.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</${n.tag}>\n`;
  if (n.opaque) return `${ind}<${n.tag}>[${n.opaque.length} bytes]</${n.tag}>\n`;
  if (!n.children?.length) return `${ind}<${n.tag}/>\n`;
  return `${ind}<${n.tag}>\n${n.children.map((c) => toXml(c, ind + '  ')).join('')}${ind}</${n.tag}>\n`;
}
