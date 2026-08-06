-- 素材组类型(对齐火山官方 GroupType;真人素材平台托管,2026-08-06)
ALTER TABLE "enterprise_asset_groups" ADD COLUMN "group_type" TEXT NOT NULL DEFAULT 'AIGC';
