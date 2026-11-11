@echo off
chcp 65001 >nul
REM ============================================================
REM  F#53 — FULL BACKEND CLEANUP (34 files / ~12,321 dead lines)
REM  Verified on HEAD 047bbf1: zero live references, boot test OK
REM  Run from the neo-store-backend repo root
REM ============================================================
echo [1/4] pull...
git pull origin main
echo [2/4] git rm 34 dead files...
git rm server.patched.js db-fixed.js fix_visibility_settings.py patch_card_swatches.py verify_card_swatches.py patch_cj_reviews.py verify_cj_reviews.py patch_reviews_v2_backend.py apply_stripe_fallback.js fix-variants.js resolve_77.js backfill_videos.js wipe_old_catalog.js wipe_old_catalog_v2.js seedReviews.js p0_migration.js global_upgrade_migration_v2.js topsellers_v2_migration.js shipping_blocked_migration.js review_invitation_migration.js migrate_token.js massCloneAllCategories.js migrate-categories.js syncCats.js category_report.js PATCH-CJ-REVIEWS.bat PATCH-REVIEWS-V2-BACKEND.bat PATCH-VISIBILITY.bat INSTALL_BACKEND.bat APPLY-CORSFIX.txt README-CJ-REVIEWS.txt README-CARD-SWATCHES.txt README-KIT35.txt kit30-diag/server.after.js
if errorlevel 1 ( echo FAIL at git rm & pause & exit /b 1 )
echo [3/4] commit...
git commit -m "chore: remove dead one-time patch kits + stale snapshots (F#53 hygiene, -12,321 lines)"
echo [4/4] done.
echo.
echo Next: review with  git show --stat HEAD   then  git push origin main
echo Render: no deploy needed (zero runtime files touched) - optional Manual Deploy to sync.
pause
