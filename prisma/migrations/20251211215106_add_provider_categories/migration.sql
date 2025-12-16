-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CategoryToProviderProfile" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_CategoryToProviderProfile_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "_CategoryToProviderProfile_B_index" ON "_CategoryToProviderProfile"("B");

-- AddForeignKey
ALTER TABLE "_CategoryToProviderProfile" ADD CONSTRAINT "_CategoryToProviderProfile_A_fkey" FOREIGN KEY ("A") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CategoryToProviderProfile" ADD CONSTRAINT "_CategoryToProviderProfile_B_fkey" FOREIGN KEY ("B") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
