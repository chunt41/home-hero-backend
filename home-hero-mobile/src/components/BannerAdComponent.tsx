import React, { useEffect } from "react";
import { View, StyleSheet, Text } from "react-native";

let BannerAd: any;
let BannerAdSize: any;

try {
  const gma = require("react-native-google-mobile-ads");
  BannerAd = gma.BannerAd;
  BannerAdSize = gma.BannerAdSize;
} catch (e) {
  // Google Mobile Ads not available (e.g., in Expo Go)
  console.log("Google Mobile Ads not available");
}

const AD_UNIT_ID = "ca-app-pub-9932102016565081/9425093050"; // Android banner ad unit ID

interface BannerAdComponentProps {
  style?: any;
}

export const BannerAdComponent: React.FC<BannerAdComponentProps> = ({
  style,
}) => {
  const [adHeight, setAdHeight] = React.useState(0);

  // If ads not available, show nothing
  if (!BannerAd) {
    return null;
  }

  return (
    <View style={[styles.adContainer, style]}>
      <BannerAd
        unitId={AD_UNIT_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{
          requestNonPersonalizedAdsOnly: false,
          keywords: ["jobs", "services", "marketplace"],
        }}
        onAdLoaded={() => setAdHeight(50)}
        onAdFailedToLoad={(error) =>
          console.log("Banner ad failed to load:", error)
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  adContainer: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f5f5f5",
  },
});
