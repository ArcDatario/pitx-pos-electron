import sql, { ConnectionPool } from "mssql";
import { randomUUID } from "crypto";
import { AppConfig, SqlServerConfig } from "./config";

let pool: ConnectionPool | null = null;
let poolKey = "";

/** "POS1\SQLEXPRESS" -> { server: "POS1", instanceName: "SQLEXPRESS" } */
function parseServer(serverStr: string): { server: string; instanceName?: string } {
  const [server, instanceName] = serverStr.split("\\");
  return instanceName ? { server, instanceName } : { server };
}

function buildMssqlConfig(sc: SqlServerConfig): sql.config {
  const { server, instanceName } = parseServer(sc.server);
  return {
    server,
    database: sc.database,
    user: sc.username,
    password: sc.password,
    options: {
      trustServerCertificate: true,
      encrypt: false,
      ...(instanceName ? { instanceName } : {}),
    },
    connectionTimeout: 8000,
    requestTimeout: 30000,
  };
}

export async function getPool(cfg: AppConfig): Promise<ConnectionPool> {
  const key = JSON.stringify(cfg.sqlserver);
  if (pool && poolKey === key && pool.connected) return pool;
  if (pool) {
    try {
      await pool.close();
    } catch {
      /* ignore */
    }
  }
  poolKey = key;
  pool = new sql.ConnectionPool(buildMssqlConfig(cfg.sqlserver));
  await pool.connect();
  return pool;
}

export async function testConnection(cfg: AppConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
  dbName?: string;
  tables?: { name: string; exists: boolean; rows?: number }[];
}> {
  try {
    const p = await getPool(cfg);
    const versionRes = await p.request().query("SELECT @@VERSION AS v");
    const version = String(versionRes.recordset[0].v).split("\n")[0];

    const dbRes = await p.request().query("SELECT DB_NAME() AS n");
    const dbName = dbRes.recordset[0].n as string;

    const tables = [];
    for (const table of ["v_salesdetails", "dts_pitx_payload"]) {
      const existsRes = await p
        .request()
        .input("t", sql.VarChar, table)
        .query(
          "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @t"
        );
      const exists = existsRes.recordset[0].c > 0;
      let rows: number | undefined;
      if (exists) {
        const countRes = await p.request().query(`SELECT COUNT(*) AS c FROM dbo.${table}`);
        rows = countRes.recordset[0].c;
      }
      tables.push({ name: table, exists, rows });
    }

    return { ok: true, message: "Connected successfully", version, dbName, tables };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

const REQUIRED_COLUMNS: Record<string, string> = {
  locationname: "VARCHAR(255) NULL",
  storenum: "INT NULL",
  ordertypename: "VARCHAR(255) NULL",
  otherdiscount: "DECIMAL(18, 2) NOT NULL DEFAULT 0",
  receipt_no: "VARCHAR(155) NULL",
  vat: "DECIMAL(18, 2) NOT NULL DEFAULT 0",
  vatable_sales: "DECIMAL(18, 2) NOT NULL DEFAULT 0",
  sc_vat_excempt_sales: "DECIMAL(18, 2) NOT NULL DEFAULT 0",
  other_tax: "DECIMAL(18, 2) NOT NULL DEFAULT 0",
  gross_sales: "DECIMAL(18, 2) NOT NULL DEFAULT 0",
  // columns needed by the submission logic ported from tsms_common.py --
  // transaction_id/uuid identify the row on TSMS; submission_checksum /
  // transaction_checksum are only ever written once TSMS has actually
  // accepted the transaction; next_retry_at implements the 429/5xx backoff
  // windows; the last_* columns log every attempt (success or failure) for
  // the "view details" panel.
  transaction_id: "VARCHAR(155) NULL",
  uuid: "VARCHAR(155) NULL",
  submission_checksum: "VARCHAR(64) NULL",
  transaction_checksum: "VARCHAR(64) NULL",
  retry_count: "INT NOT NULL DEFAULT 0",
  next_retry_at: "DATETIME2 NULL",
  last_error: "VARCHAR(2000) NULL",
  last_payload_sent: "NVARCHAR(MAX) NULL",
  last_response_body: "NVARCHAR(MAX) NULL",
  last_response_code: "INT NULL",
  last_attempt_at: "DATETIME2 NULL",
};

async function ensureColumnsExist(p: ConnectionPool): Promise<void> {
  for (const [col, colType] of Object.entries(REQUIRED_COLUMNS)) {
    try {
      const existsRes = await p
        .request()
        .input("c", sql.VarChar, col)
        .query(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'dts_pitx_payload' AND COLUMN_NAME = @c"
        );
      if (existsRes.recordset.length === 0) {
        await p.request().query(`ALTER TABLE dbo.dts_pitx_payload ADD [${col}] ${colType}`);
      }
    } catch {
      /* mirrors the Python app: best-effort, ignore per-column failures */
    }
  }
}

/**
 * 1:1 port of tsms_pos/pos.py::transfer(). Aggregates dbo.v_salesdetails into
 * dbo.dts_pitx_payload for [startDate, endDate], handling voided FCRInvNumbers
 * (negative "Item Sale" rows) as their own void records.
 */
export async function transfer(
  cfg: AppConfig,
  startDate: string,
  endDate: string
): Promise<number> {
  const p = await getPool(cfg);
  await ensureColumnsExist(p);

  const { locationname, storenum } = cfg.filters;

  const query = `
    DECLARE @startDate DATE = @p_startDate;
    DECLARE @endDate DATE = @p_endDate;
    SET NOCOUNT ON;

    WITH VoidFCR AS (
        SELECT DISTINCT FCRInvNumber
        FROM dbo.v_salesdetails
        WHERE BusinessDate BETWEEN @startDate AND @endDate
          AND Transtype = 'Item Sale'
          AND amt < 0
          AND FCRInvNumber IS NOT NULL
          AND FCRInvNumber <> ''
    ),
    SoloParentDiscount AS (
        SELECT DISTINCT FCRInvNumber
        FROM dbo.v_salesdetails
        WHERE BusinessDate BETWEEN @startDate AND @endDate
          AND Transtype = 'Discount'
          AND Itemname LIKE 'Solo Parent%'
          AND FCRInvNumber IS NOT NULL
          AND FCRInvNumber <> ''
    ),
    VoidAgg AS (
        SELECT
            v.BusinessDate,
            MAX(v.sys_datetime) AS transdatetime,
            v.FCRInvNumber AS guestcheckid,
            MAX(v.order_type) AS ordertypename,
            MAX(v.FCRInvNumber) AS receipt_no,
            -- netsales:
            -- Solo Parent: (amt / 1.12) - ((amt / 1.12) * 0.10) = gross_sales - lessSoloparent
            -- Others: netsales from source
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN (SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12) -
                     ((SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12) * 0.10)
                ELSE SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0))
            END AS netsales,
            -- vat_12: 
            -- Solo Parent: 0 (VAT goes to lessvat)
            -- VAT-exempt (Zero Rated, PWD, Senior Citizen): 0
            -- Employee, National Athlete, Standard: 12% of netsales
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL OR MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                THEN 0
                ELSE SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) * 0.12
            END AS vat_12,
            -- lessvat:
            -- Solo Parent: amt - (amt / 1.12) = VAT amount
            -- VAT-exempt (Zero Rated, PWD, Senior Citizen): 12% of netsales
            -- Employee, Standard, National Athlete: 0
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) -
                     (SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12)
                WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) * 0.12
                ELSE 0
            END AS lessvat,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.LessPWD ELSE 0 END), 0)) AS lessPWD,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.LessSC ELSE 0 END), 0)) AS lessSC,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessemp ELSE 0 END), 0)) AS lessEMP,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessNationalAth ELSE 0 END), 0)) AS lessNtnlAth,
            -- lessSoloparent: 10% of (amt / 1.12)
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN (SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12) * 0.10
                ELSE SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessSoloparent ELSE 0 END), 0))
            END AS lessSoloparent,
            SUM(ISNULL(ABS(CASE WHEN v.amt < 0 THEN v.amt ELSE 0 END), 0)) AS voidtotal_amt,
            SUM(ISNULL(ABS(CASE WHEN v.amt < 0 THEN v.qty ELSE 0 END), 0)) AS voidtotal_qty,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.srvc_amt ELSE 0 END), 0)) AS gc_sales,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.GC_excess ELSE 0 END), 0)) AS gc_excess,
            SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.other_disc ELSE 0 END), 0)) AS otherdiscount,
            -- vat: Same logic as vat_12
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL OR MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                THEN 0
                ELSE SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) * 0.12
            END AS vat,
            -- gross_sales: 
            -- Solo Parent: amt / 1.12
            -- Others: netsales + vat + lessNtnlAth + lessSoloparent + lessEMP
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12
                ELSE SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) +
                     (CASE 
                        WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                        THEN 0
                        ELSE SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) * 0.12
                     END) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessNationalAth ELSE 0 END), 0)) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessSoloparent ELSE 0 END), 0)) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessemp ELSE 0 END), 0))
            END AS gross_sales,
            -- vatable_sales: If lessvat = 0 -> VATable
            CASE
                WHEN (CASE 
                    WHEN sp.FCRInvNumber IS NOT NULL
                    THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) -
                         (SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12)
                    WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                    THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) * 0.12
                    ELSE 0
                END) = 0
                THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0))
                ELSE 0
            END AS vatable_sales,
            -- sc_vat_excempt_sales: If lessvat > 0 -> VAT-exempt
            CASE
                WHEN (CASE 
                    WHEN sp.FCRInvNumber IS NOT NULL
                    THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) -
                         (SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.amt ELSE 0 END), 0)) / 1.12)
                    WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                    THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) * 0.12
                    ELSE 0
                END) > 0
                THEN SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.Netsales ELSE 0 END), 0)) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.LessSC ELSE 0 END), 0)) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.LessPWD ELSE 0 END), 0)) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessNationalAth ELSE 0 END), 0)) +
                     SUM(ISNULL(ABS(CASE WHEN v.amt > 0 THEN v.lessSoloparent ELSE 0 END), 0))
                ELSE 0
            END AS sc_vat_excempt_sales,
            0 AS other_tax
        FROM dbo.v_salesdetails v
        INNER JOIN VoidFCR vf ON v.FCRInvNumber = vf.FCRInvNumber
        LEFT JOIN SoloParentDiscount sp ON v.FCRInvNumber = sp.FCRInvNumber
        WHERE v.Transtype = 'Item Sale'
          AND v.BusinessDate BETWEEN @startDate AND @endDate
        GROUP BY v.BusinessDate, v.FCRInvNumber, sp.FCRInvNumber
    ),
    NormalAgg AS (
        SELECT
            v.BusinessDate,
            MAX(v.sys_datetime) AS transdatetime,
            MAX(v.FCRInvNumber) AS guestcheckid,
            MAX(v.order_type) AS ordertypename,
            MAX(v.FCRInvNumber) AS receipt_no,
            -- netsales:
            -- Solo Parent: (amt / 1.12) - ((amt / 1.12) * 0.10) = gross_sales - lessSoloparent
            -- Others: netsales from source
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN (SUM(ISNULL(ABS(v.amt), 0)) / 1.12) -
                     ((SUM(ISNULL(ABS(v.amt), 0)) / 1.12) * 0.10)
                ELSE SUM(ISNULL(ABS(v.Netsales), 0))
            END AS netsales,
            -- vat_12:
            -- Solo Parent: 0 (VAT goes to lessvat)
            -- VAT-exempt (Zero Rated, PWD, Senior Citizen): 0
            -- Employee, National Athlete, Standard: 12% of netsales
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL OR MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                THEN 0
                ELSE SUM(ISNULL(ABS(v.Netsales), 0)) * 0.12
            END AS vat_12,
            -- lessvat:
            -- Solo Parent: amt - (amt / 1.12) = VAT amount
            -- VAT-exempt (Zero Rated, PWD, Senior Citizen): 12% of netsales
            -- Employee, Standard, National Athlete: 0
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN SUM(ISNULL(ABS(v.amt), 0)) - (SUM(ISNULL(ABS(v.amt), 0)) / 1.12)
                WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                THEN SUM(ISNULL(ABS(v.Netsales), 0)) * 0.12
                ELSE 0
            END AS lessvat,
            SUM(ISNULL(ABS(v.LessPWD), 0)) AS lessPWD,
            SUM(ISNULL(ABS(v.LessSC), 0)) AS lessSC,
            SUM(ISNULL(ABS(v.lessemp), 0)) AS lessEMP,
            SUM(ISNULL(ABS(v.lessNationalAth), 0)) AS lessNtnlAth,
            -- lessSoloparent: 10% of (amt / 1.12)
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN (SUM(ISNULL(ABS(v.amt), 0)) / 1.12) * 0.10
                ELSE SUM(ISNULL(ABS(v.lessSoloparent), 0))
            END AS lessSoloparent,
            0 AS voidtotal_amt,
            0 AS voidtotal_qty,
            SUM(ISNULL(ABS(v.srvc_amt), 0)) AS gc_sales,
            SUM(ISNULL(ABS(v.GC_excess), 0)) AS gc_excess,
            SUM(ISNULL(ABS(v.other_disc), 0)) AS otherdiscount,
            -- vat: Same logic as vat_12
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL OR MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                THEN 0
                ELSE SUM(ISNULL(ABS(v.Netsales), 0)) * 0.12
            END AS vat,
            -- gross_sales: 
            -- Solo Parent: amt / 1.12
            -- Others: netsales + vat + lessNtnlAth + lessSoloparent + lessEMP
            CASE 
                WHEN sp.FCRInvNumber IS NOT NULL
                THEN SUM(ISNULL(ABS(v.amt), 0)) / 1.12
                ELSE SUM(ISNULL(ABS(v.Netsales), 0)) +
                     (CASE 
                        WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                        THEN 0
                        ELSE SUM(ISNULL(ABS(v.Netsales), 0)) * 0.12
                     END) +
                     SUM(ISNULL(ABS(v.lessNationalAth), 0)) +
                     SUM(ISNULL(ABS(v.lessSoloparent), 0)) +
                     SUM(ISNULL(ABS(v.lessemp), 0))
            END AS gross_sales,
            -- vatable_sales: If lessvat = 0 -> VATable
            CASE
                WHEN (CASE 
                    WHEN sp.FCRInvNumber IS NOT NULL
                    THEN SUM(ISNULL(ABS(v.amt), 0)) - (SUM(ISNULL(ABS(v.amt), 0)) / 1.12)
                    WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                    THEN SUM(ISNULL(ABS(v.Netsales), 0)) * 0.12
                    ELSE 0
                END) = 0
                THEN SUM(ISNULL(ABS(v.Netsales), 0))
                ELSE 0
            END AS vatable_sales,
            -- sc_vat_excempt_sales: If lessvat > 0 -> VAT-exempt
            CASE
                WHEN (CASE 
                    WHEN sp.FCRInvNumber IS NOT NULL
                    THEN SUM(ISNULL(ABS(v.amt), 0)) - (SUM(ISNULL(ABS(v.amt), 0)) / 1.12)
                    WHEN MAX(v.order_type) IN ('Zero Rated', 'PWD', 'Senior Citizen')
                    THEN SUM(ISNULL(ABS(v.Netsales), 0)) * 0.12
                    ELSE 0
                END) > 0
                THEN SUM(ISNULL(ABS(v.Netsales), 0)) +
                     SUM(ISNULL(ABS(v.LessSC), 0)) +
                     SUM(ISNULL(ABS(v.LessPWD), 0)) +
                     SUM(ISNULL(ABS(v.lessNationalAth), 0)) +
                     SUM(ISNULL(ABS(v.lessSoloparent), 0))
                ELSE 0
            END AS sc_vat_excempt_sales,
            0 AS other_tax
        FROM dbo.v_salesdetails v
        LEFT JOIN VoidFCR vf ON v.FCRInvNumber = vf.FCRInvNumber
        LEFT JOIN SoloParentDiscount sp ON v.FCRInvNumber = sp.FCRInvNumber
        WHERE vf.FCRInvNumber IS NULL
          AND v.Transtype = 'Item Sale'
          AND v.amt > 0
          AND v.BusinessDate BETWEEN @startDate AND @endDate
        GROUP BY v.BusinessDate, v.CheckNumber, sp.FCRInvNumber
    ),
    CombinedData AS (
        SELECT * FROM VoidAgg
        UNION ALL
        SELECT * FROM NormalAgg
    ),
    DeduplicatedData AS (
        SELECT
            BusinessDate, transdatetime, guestcheckid, ordertypename, receipt_no,
            netsales, vat_12, lessvat, lessPWD, lessSC, lessEMP, lessNtnlAth, lessSoloparent,
            voidtotal_amt, voidtotal_qty, gc_sales, gc_excess, otherdiscount,
            vat, gross_sales, vatable_sales, sc_vat_excempt_sales, other_tax,
            ROW_NUMBER() OVER (PARTITION BY receipt_no ORDER BY transdatetime DESC) AS rn
        FROM CombinedData
        WHERE receipt_no IS NOT NULL AND receipt_no <> ''
    )
    INSERT INTO dbo.dts_pitx_payload (
        businessdate, transdatetime, locationname, storenum,
        GUESTCHECKID, ordertypename, receipt_no,
        netsales, vat_12, lessvat, lessPWD, lessSC, lessEMP,
        lessNtnlAth, lessSoloparent, voidtotal_amt, voidtotal_qty,
        gc_sales, gc_excess, otherdiscount,
        vat, gross_sales, vatable_sales, sc_vat_excempt_sales, other_tax,
        status, updated_at
    )
    SELECT
        BusinessDate, transdatetime, @p_locationname, @p_storenum,
        guestcheckid, ordertypename, receipt_no,
        netsales, vat_12, lessvat, lessPWD, lessSC, lessEMP,
        lessNtnlAth, lessSoloparent, voidtotal_amt, voidtotal_qty,
        gc_sales, gc_excess, otherdiscount,
        vat, gross_sales, vatable_sales, sc_vat_excempt_sales, other_tax,
        'pending', SYSDATETIME()
    FROM DeduplicatedData
    WHERE rn = 1
      AND NOT EXISTS (
          SELECT 1 FROM dbo.dts_pitx_payload t WHERE t.receipt_no = DeduplicatedData.receipt_no
      );

    SELECT @@ROWCOUNT AS InsertedCount;
  `;

  const result = await p
    .request()
    .input("p_startDate", sql.Date, startDate)
    .input("p_endDate", sql.Date, endDate)
    .input("p_locationname", sql.VarChar, locationname)
    .input("p_storenum", sql.Int, storenum)
    .query(query);

  const inserted = result.recordset?.[0]?.InsertedCount ?? result.rowsAffected.at(-1) ?? 0;
  return Math.max(0, inserted);
}

export interface RecordFilters {
  guestCheckId?: string;
  date?: string; // YYYY-MM-DD
  status?: "" | "pending" | "submitted" | "failed" | "voided";
}

export async function getStatusCounts(
  cfg: AppConfig
): Promise<Record<string, number>> {
  const p = await getPool(cfg);
  const res = await p
    .request()
    .query("SELECT status, COUNT(*) AS c FROM dbo.dts_pitx_payload GROUP BY status");
  const counts: Record<string, number> = { total: 0, pending: 0, submitted: 0, failed: 0, voided: 0 };
  for (const row of res.recordset) {
    const key = String(row.status ?? "").toLowerCase();
    if (key in counts) counts[key] = row.c;
    counts.total += row.c;
  }
  return counts;
}

export async function getSummaryMetrics(
  cfg: AppConfig,
  filters: RecordFilters
): Promise<Record<string, number>> {
  const p = await getPool(cfg);
  const req = p.request();
  const where = buildWhereClause(req, filters);
  const res = await req.query(`
    SELECT
      ISNULL(SUM(netsales), 0) AS netsales,
      ISNULL(SUM(vat_12), 0) AS vat_12,
      ISNULL(SUM(lessvat), 0) AS lessvat,
      ISNULL(SUM(lessSC), 0) AS lessSC,
      ISNULL(SUM(lessPWD), 0) AS lessPWD,
      ISNULL(SUM(lessNtnlAth), 0) AS lessNtnlAth,
      ISNULL(SUM(lessSoloparent), 0) AS lessSoloParent,
      ISNULL(SUM(lessEMP), 0) AS lessEMP,
      ISNULL(SUM(gc_excess), 0) AS gc_excess,
      ISNULL(SUM(voidtotal_amt), 0) AS void_amt,
      ISNULL(SUM(gross_sales), 0) AS total_revenue
    FROM dbo.dts_pitx_payload
    ${where}
  `);
  return res.recordset[0];
}

function buildWhereClause(req: sql.Request, filters: RecordFilters): string {
  const clauses: string[] = [];
  if (filters.guestCheckId) {
    req.input("guestCheckId", sql.VarChar, `%${filters.guestCheckId}%`);
    clauses.push("GUESTCHECKID LIKE @guestCheckId");
  }
  if (filters.date) {
    req.input("date", sql.Date, filters.date);
    clauses.push("businessdate = @date");
  }
  if (filters.status) {
    req.input("status", sql.VarChar, filters.status);
    clauses.push("LOWER(status) = LOWER(@status)");
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export async function fetchRecords(
  cfg: AppConfig,
  filters: RecordFilters,
  page: number,
  pageSize: number
): Promise<{ rows: any[]; total: number }> {
  const p = await getPool(cfg);

  const countReq = p.request();
  const countWhere = buildWhereClause(countReq, filters);
  const countRes = await countReq.query(
    `SELECT COUNT(*) AS c FROM dbo.dts_pitx_payload ${countWhere}`
  );
  const total = countRes.recordset[0].c as number;

  const req = p.request();
  const where = buildWhereClause(req, filters);
  req.input("offset", sql.Int, Math.max(0, (page - 1) * pageSize));
  req.input("pageSize", sql.Int, pageSize);
  const res = await req.query(`
    SELECT * FROM dbo.dts_pitx_payload
    ${where}
    ORDER BY businessdate DESC, transdatetime DESC
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `);

  return { rows: res.recordset, total };
}

/**
 * Rows eligible for (re)submission in [startDate, endDate] -- 1:1 port of
 * tsms_common.py::fetch_pending_by_date()'s eligibility rule, extended
 * across a date range: never touches 'submitted'/'voided' rows, keeps
 * 'failed' rows eligible only while retry_count < max_retries, and honors
 * any backoff/rate-limit window set on next_retry_at.
 */
export async function fetchPendingByDate(
  cfg: AppConfig,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const p = await getPool(cfg);
  const res = await p
    .request()
    .input("start", sql.Date, startDate)
    .input("end", sql.Date, endDate)
    .input("maxRetries", sql.Int, cfg.worker.max_retries)
    .query(`
      SELECT * FROM dbo.dts_pitx_payload
      WHERE businessdate BETWEEN @start AND @end
        AND LOWER(status) NOT IN ('submitted', 'voided')
        AND (LOWER(status) = 'pending' OR retry_count < @maxRetries)
        AND (next_retry_at IS NULL OR next_retry_at <= SYSDATETIME())
      ORDER BY businessdate ASC, transdatetime ASC
    `);
  return res.recordset;
}

export async function fetchRecordByGuestCheckId(cfg: AppConfig, guestCheckId: string) {
  const p = await getPool(cfg);
  const res = await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .query("SELECT TOP 1 * FROM dbo.dts_pitx_payload WHERE GUESTCHECKID = @id");
  return res.recordset[0] ?? null;
}

export async function resetForResubmit(cfg: AppConfig, guestCheckId: string): Promise<boolean> {
  const p = await getPool(cfg);
  // Mirrors tsms_common.py::reset_for_resubmit(): refuses to touch a row
  // that's already status='submitted', enforced here at the DB layer (not
  // just the UI), so an already-accepted transaction can never be resent.
  const res = await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .query(`
      UPDATE dbo.dts_pitx_payload
      SET status = 'pending', retry_count = 0, next_retry_at = NULL,
          last_error = NULL, updated_at = SYSDATETIME()
      WHERE GUESTCHECKID = @id AND status <> 'submitted'
    `);
  return (res.rowsAffected[0] ?? 0) > 0;
}

/**
 * transaction_id must stay fixed across retries (Sec 13.4). Rows should
 * already have one from aggregation, so this is a safety net -- generated
 * once here and persisted immediately, before the first send attempt --
 * never regenerated afterwards (except the deliberate 409 case handled in
 * tsms.ts::submitOne via updateTransactionId). 1:1 port of
 * ensure_transaction_id().
 */
export async function ensureTransactionId(
  cfg: AppConfig,
  guestCheckId: string,
  existingTransactionId: string | null
): Promise<string> {
  if (existingTransactionId) return existingTransactionId;
  const p = await getPool(cfg);
  const newId = randomUUID();
  await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .input("txId", sql.VarChar, newId)
    .query(`
      UPDATE dbo.dts_pitx_payload
      SET transaction_id = @txId, updated_at = SYSDATETIME()
      WHERE GUESTCHECKID = @id AND transaction_id IS NULL
    `);
  return newId;
}

/** Only used for the deliberate 409-conflict-on-a-pending-row case in
 * submitOne() -- persists the freshly generated transaction_id so the row
 * and every subsequent call (including a post-submit void) stay in sync. */
export async function updateTransactionId(cfg: AppConfig, guestCheckId: string, newTransactionId: string): Promise<void> {
  const p = await getPool(cfg);
  await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .input("txId", sql.VarChar, newTransactionId)
    .query(`UPDATE dbo.dts_pitx_payload SET transaction_id = @txId WHERE GUESTCHECKID = @id`);
}

/** Logs every attempt -- success or failure -- so a "view details" panel
 * can always show the full request payload and full API response,
 * regardless of outcome. 1:1 port of record_attempt(). */
export async function recordAttempt(
  cfg: AppConfig,
  guestCheckId: string,
  submission: Record<string, any>,
  responseData: any,
  httpCode: number | null
): Promise<void> {
  const p = await getPool(cfg);
  await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify(submission, null, 2))
    .input("response", sql.NVarChar(sql.MAX), responseData !== null && responseData !== undefined ? JSON.stringify(responseData, null, 2) : null)
    .input("code", sql.Int, httpCode)
    .query(`
      UPDATE dbo.dts_pitx_payload SET
        last_payload_sent = @payload,
        last_response_body = @response,
        last_response_code = @code,
        last_attempt_at = SYSDATETIME(),
        updated_at = SYSDATETIME()
      WHERE GUESTCHECKID = @id
    `);
}

/** Only writes submission_uuid/checksums once TSMS has actually accepted
 * the transaction -- they stay blank until success. transaction_id was
 * already set earlier and is left untouched here. 1:1 port of
 * mark_submitted(). */
export async function markSubmitted(cfg: AppConfig, guestCheckId: string, submission: Record<string, any>): Promise<void> {
  const p = await getPool(cfg);
  await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .input("uuid", sql.VarChar, submission.submission_uuid)
    .input("subChecksum", sql.VarChar, submission.payload_checksum)
    .input("txnChecksum", sql.VarChar, submission.transaction?.payload_checksum ?? null)
    .query(`
      UPDATE dbo.dts_pitx_payload SET
        status = 'submitted',
        uuid = @uuid,
        submission_checksum = @subChecksum,
        transaction_checksum = @txnChecksum,
        next_retry_at = NULL,
        last_error = NULL,
        updated_at = SYSDATETIME()
      WHERE GUESTCHECKID = @id
    `);
}

/** Marks a row as voided after a successful void API call. 1:1 port of
 * mark_voided(). */
export async function markVoided(
  cfg: AppConfig,
  guestCheckId: string,
  voidPayload: { submission_uuid?: string; payload_checksum?: string }
): Promise<void> {
  const p = await getPool(cfg);
  await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .input("uuid", sql.VarChar, voidPayload.submission_uuid ?? null)
    .input("checksum", sql.VarChar, voidPayload.payload_checksum ?? null)
    .query(`
      UPDATE dbo.dts_pitx_payload SET
        status = 'voided',
        uuid = @uuid,
        submission_checksum = @checksum,
        next_retry_at = NULL,
        last_error = NULL,
        updated_at = SYSDATETIME()
      WHERE GUESTCHECKID = @id
    `);
}

/** 429 responses don't count against retry_count -- just pause and try
 * again after the server-specified delay (Sec 13.2). 1:1 port of
 * mark_rate_limited(). */
export async function markRateLimited(cfg: AppConfig, guestCheckId: string, retryAfterSeconds: number, message: string): Promise<void> {
  const p = await getPool(cfg);
  await p
    .request()
    .input("id", sql.VarChar, guestCheckId)
    .input("err", sql.VarChar, message.slice(0, 500))
    .input("delaySeconds", sql.Int, Math.round(retryAfterSeconds))
    .query(`
      UPDATE dbo.dts_pitx_payload SET
        last_error = @err,
        next_retry_at = DATEADD(SECOND, @delaySeconds, SYSDATETIME()),
        updated_at = SYSDATETIME()
      WHERE GUESTCHECKID = @id
    `);
}

/**
 * Used for every failure type (retryable 5xx/network AND terminal
 * 401/403/409/422) so both behave the same way in fetchPendingByDate:
 * retry_count increments by 1 per attempt, and the row stays eligible for
 * resubmission until it's actually been tried maxRetries times -- not
 * instantly locked out after a single terminal error (a bad token is often
 * fixed outside the payload, e.g. updating it in Settings, so it's
 * reasonable to keep retrying those too; a 409 data conflict will just keep
 * failing harmlessly until someone investigates). backoffSeconds=0 means
 * "eligible again next cycle" (terminal errors); a positive value applies
 * exponential backoff (5xx/network errors, Sec 13.1). 1:1 port of
 * mark_failed().
 */
export async function markFailed(
  cfg: AppConfig,
  guestCheckId: string,
  message: string,
  currentRetryCount: number,
  maxRetries: number,
  backoffSeconds = 0
): Promise<boolean> {
  const p = await getPool(cfg);
  const newCount = currentRetryCount + 1;
  if (backoffSeconds) {
    await p
      .request()
      .input("id", sql.VarChar, guestCheckId)
      .input("count", sql.Int, newCount)
      .input("err", sql.VarChar, message.slice(0, 500))
      .input("delaySeconds", sql.Int, backoffSeconds)
      .query(`
        UPDATE dbo.dts_pitx_payload SET
          status = 'failed', retry_count = @count, last_error = @err,
          next_retry_at = DATEADD(SECOND, @delaySeconds, SYSDATETIME()),
          updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = @id
      `);
  } else {
    await p
      .request()
      .input("id", sql.VarChar, guestCheckId)
      .input("count", sql.Int, newCount)
      .input("err", sql.VarChar, message.slice(0, 500))
      .query(`
        UPDATE dbo.dts_pitx_payload SET
          status = 'failed', retry_count = @count, last_error = @err,
          next_retry_at = NULL, updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = @id
      `);
  }
  return newCount >= maxRetries;
}

/**
 * Creates dbo.dts_pitx_payload if it doesn't exist yet, using every column
 * this app reads or writes. Run from the Install tab against a fresh
 * CheckPostingDB. If your original deployment used a different schema
 * script, prefer that one instead - this is a best-effort recreation.
 */
export async function installCreateTable(cfg: AppConfig): Promise<void> {
  const p = await getPool(cfg);
  await p.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'dts_pitx_payload')
    BEGIN
      CREATE TABLE dbo.dts_pitx_payload (
        id INT IDENTITY(1,1) PRIMARY KEY,
        businessdate DATE NOT NULL,
        transdatetime DATETIME2 NULL,
        locationname VARCHAR(255) NULL,
        storenum INT NULL,
        GUESTCHECKID VARCHAR(155) NOT NULL,
        ordertypename VARCHAR(255) NULL,
        receipt_no VARCHAR(155) NULL,
        netsales DECIMAL(18,2) NOT NULL DEFAULT 0,
        vat_12 DECIMAL(18,2) NOT NULL DEFAULT 0,
        lessvat DECIMAL(18,2) NOT NULL DEFAULT 0,
        lessPWD DECIMAL(18,2) NOT NULL DEFAULT 0,
        lessSC DECIMAL(18,2) NOT NULL DEFAULT 0,
        lessEMP DECIMAL(18,2) NOT NULL DEFAULT 0,
        lessNtnlAth DECIMAL(18,2) NOT NULL DEFAULT 0,
        lessSoloparent DECIMAL(18,2) NOT NULL DEFAULT 0,
        voidtotal_amt DECIMAL(18,2) NOT NULL DEFAULT 0,
        voidtotal_qty DECIMAL(18,2) NOT NULL DEFAULT 0,
        gc_sales DECIMAL(18,2) NOT NULL DEFAULT 0,
        gc_excess DECIMAL(18,2) NOT NULL DEFAULT 0,
        otherdiscount DECIMAL(18,2) NOT NULL DEFAULT 0,
        vat DECIMAL(18,2) NOT NULL DEFAULT 0,
        gross_sales DECIMAL(18,2) NOT NULL DEFAULT 0,
        vatable_sales DECIMAL(18,2) NOT NULL DEFAULT 0,
        sc_vat_excempt_sales DECIMAL(18,2) NOT NULL DEFAULT 0,
        other_tax DECIMAL(18,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        retry_count INT NOT NULL DEFAULT 0,
        next_retry_at DATETIME2 NULL,
        transaction_id VARCHAR(155) NULL,
        uuid VARCHAR(155) NULL,
        submission_checksum VARCHAR(64) NULL,
        transaction_checksum VARCHAR(64) NULL,
        last_error VARCHAR(2000) NULL,
        last_payload_sent NVARCHAR(MAX) NULL,
        last_response_body NVARCHAR(MAX) NULL,
        last_response_code INT NULL,
        last_attempt_at DATETIME2 NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
      );
      CREATE UNIQUE INDEX UX_dts_pitx_payload_receipt_no ON dbo.dts_pitx_payload(receipt_no)
        WHERE receipt_no IS NOT NULL;
    END
  `);
}