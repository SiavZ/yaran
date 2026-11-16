# iOS store lanes: signed App Store build, TestFlight upload, App Review submission.
#
# Signing is fastlane match (readonly) with a team App Store Connect API key; the
# notification service extension is signed alongside the app (Phase 16's NSE target).
platform :ios do
  private_lane :asc_key do
    app_store_connect_api_key(
      key_id: required_env("ASC_KEY_ID"),
      issuer_id: required_env("ASC_ISSUER_ID"),
      key_content: required_env("ASC_KEY_P8_B64"),
      is_key_content_base64: true
    )
  end

  desc "Build the signed App Store IPA into IOS_OUTPUT_DIR (default build/ios)"
  lane :build do
    setup_ci
    asc_key
    app_id = Publisher.app_id!
    Publisher.team_id!
    match(type: "appstore", readonly: true, app_identifier: [app_id, "#{app_id}.NotificationService"])
    build_app(
      project: File.join(REPO_ROOT, "mobile/ios/App/App.xcodeproj"),
      scheme: "App",
      configuration: "Release",
      export_method: "app-store",
      output_directory: ENV["IOS_OUTPUT_DIR"].to_s.empty? ? "build/ios" : ENV["IOS_OUTPUT_DIR"],
      xcargs: "REQUIRE_PUBLISHER_DOMAIN=YES"
    )
  end

  desc "Upload IOS_IPA_PATH to TestFlight without waiting for processing"
  lane :beta do
    asc_key
    upload_to_testflight(ipa: required_env("IOS_IPA_PATH"), skip_waiting_for_build_processing: true)
  end

  desc "Submit IOS_APP_VERSION for App Review with phased release"
  lane :submit do
    asc_key
    deliver(
      app_identifier: Publisher.app_id!,
      app_version: required_env("IOS_APP_VERSION"),
      metadata_path: File.join(REPO_ROOT, "mobile/fastlane/metadata"),
      submit_for_review: true,
      phased_release: true,
      skip_binary_upload: true,
      skip_screenshots: true,
      force: true,
      precheck_include_in_app_purchases: false
    )
  end
end
