package ai.procurecopilot.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // V2: native Hyperpure-app reader plugin (Accessibility-backed).
        registerPlugin(HyperpureNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
