/*
  Warnings:

  - You are about to drop the column `comment` on the `Review` table. All the data in the column will be lost.
  - You are about to drop the column `consumerId` on the `Review` table. All the data in the column will be lost.
  - You are about to drop the column `providerId` on the `Review` table. All the data in the column will be lost.
  - Made the column `revieweeUserId` on table `Review` required. This step will fail if there are existing NULL values in that column.
  - Made the column `reviewerUserId` on table `Review` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_consumerId_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_providerId_fkey";

-- AlterTable
ALTER TABLE "Review" DROP COLUMN "comment",
DROP COLUMN "consumerId",
DROP COLUMN "providerId",
ALTER COLUMN "revieweeUserId" SET NOT NULL,
ALTER COLUMN "reviewerUserId" SET NOT NULL;
