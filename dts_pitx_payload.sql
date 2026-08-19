USE [CheckPostingDB]
GO

/****** Object:  Table [dbo].[dts_pitx_payload]    Script Date: 8/19/2026 11:46:26 AM ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[dts_pitx_payload](
	[businessdate] [date] NULL,
	[transdatetime] [datetime] NULL,
	[locationname] [varchar](255) NULL,
	[GUESTCHECKID] [varchar](255) NULL,
	[netsales] [decimal](18, 2) NOT NULL,
	[vat_12] [decimal](18, 2) NOT NULL,
	[lessvat] [decimal](18, 2) NOT NULL,
	[lessPWD] [decimal](18, 2) NOT NULL,
	[lessSC] [decimal](18, 2) NOT NULL,
	[lessEMP] [decimal](18, 2) NOT NULL,
	[lessNtnlAth] [decimal](18, 2) NOT NULL,
	[lessSoloparent] [decimal](18, 2) NOT NULL,
	[voidtotal_amt] [decimal](18, 2) NOT NULL,
	[voidtotal_qty] [decimal](18, 2) NOT NULL,
	[gc_sales] [decimal](18, 2) NOT NULL,
	[gc_excess] [decimal](18, 2) NOT NULL,
	[otherdiscount] [decimal](18, 2) NOT NULL,
	[status] [varchar](20) NULL,
	[submission_timestamp] [datetime] NULL,
	[submission_uuid] [varchar](255) NULL,
	[transaction_id] [varchar](255) NULL,
	[submission_checksum] [varchar](255) NULL,
	[transaction_checksum] [varchar](255) NULL,
	[retry_count] [int] NOT NULL,
	[last_error] [varchar](500) NULL,
	[updated_at] [datetime2](7) NOT NULL,
	[next_retry_at] [datetime2](7) NULL,
	[last_payload_sent] [nvarchar](max) NULL,
	[last_response_body] [nvarchar](max) NULL,
	[last_response_code] [int] NULL,
	[last_attempt_at] [datetime2](7) NULL,
	[receipt_no] [varchar](155) NULL,
	[storenum] [int] NULL,
	[ordertypename] [varchar](255) NULL,
	[payload_id] [int] IDENTITY(1,1) NOT NULL,
	[vat] [decimal](18, 2) NOT NULL,
	[vatable_sales] [decimal](18, 2) NOT NULL,
	[sc_vat_excempt_sales] [decimal](18, 2) NOT NULL,
	[other_tax] [decimal](18, 2) NOT NULL,
	[gross_sales] [decimal](18, 2) NOT NULL,
	[uuid] [varchar](155) NULL,
 CONSTRAINT [PK_dts_pitx_payload] PRIMARY KEY NONCLUSTERED 
(
	[payload_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT ((0)) FOR [retry_count]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT (sysdatetime()) FOR [updated_at]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT ((0)) FOR [vat]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT ((0)) FOR [vatable_sales]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT ((0)) FOR [sc_vat_excempt_sales]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT ((0)) FOR [other_tax]
GO

ALTER TABLE [dbo].[dts_pitx_payload] ADD  DEFAULT ((0)) FOR [gross_sales]
GO


