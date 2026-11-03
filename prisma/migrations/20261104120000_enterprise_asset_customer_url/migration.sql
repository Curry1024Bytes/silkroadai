-- 素材双写客户自定义 OSS:副本的公网 URL(对客展示优先;纯加列,默认 null,存量行不受影响)
ALTER TABLE "enterprise_assets" ADD COLUMN "customer_url" TEXT;
