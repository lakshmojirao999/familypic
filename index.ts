import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as synced_folder from "@pulumi/synced-folder";

const config = new pulumi.Config();
const domain = config.require("domain");
const subdomain = config.require("subdomain");
const mydomainName = `${subdomain}.${domain}`;
const path = config.get("path") || "./www/dist";

// Look up your existing Route 53 hosted zone.
const zone = aws.route53.getZoneOutput({ name: domain });

// Provision a new ACM certificate.
const certificate = new aws.acm.Certificate("certificate",
    {
        domainName: "*" + "." + domain,
        validationMethod: "DNS",
    },
    {
        // ACM certificates must be created in the us-east-1 region.
        provider: new aws.Provider("default", {
            region: "us-east-1",
        }),
    },
);

// Validate the ACM certificate with DNS.
const validationOption = certificate.domainValidationOptions[0];
const certificateValidation = new aws.route53.Record("certificate-validation", {
    name: validationOption.resourceRecordName,
    type: validationOption.resourceRecordType,
    records: [ validationOption.resourceRecordValue ],
    zoneId: zone.zoneId,
    ttl: 60,
});


// Create an AWS resource (S3 Bucket)
const bucket = new aws.s3.BucketV2("flex");

const website = new aws.s3.BucketWebsiteConfigurationV2("website", {
    bucket: bucket.id,
    indexDocument: {
        suffix: "index.html",
    }, 

    
});

const ownershipControls = new aws.s3.BucketOwnershipControls("ownership-controls", {
    bucket: bucket.id,
    rule: {
        objectOwnership: "ObjectWriter"
    }
});

const publicAccessBlock = new aws.s3.BucketPublicAccessBlock("public-access-block", {
    bucket: bucket.id,
    blockPublicAcls: false,
});

// const bucketObject = new aws.s3.BucketObject("index.html", {
//     key: "index.html",
//     bucket: bucket.id,
//     source: new pulumi.asset.FileAsset("./www/index.html"),
//     contentType: "text/html",
//     acl: "public-read",
// },{ dependsOn: [publicAccessBlock,ownershipControls,website] });

// Use a synced folder to manage the files of the website.
const bucketFolder = new synced_folder.S3BucketFolder("bucket-folder", {
    path: path,
    bucketName: bucket.bucket,
    acl: "public-read",
}, 
{ dependsOn: [publicAccessBlock,ownershipControls,website] });



// Create an Origin Access Identity (OAI) for CloudFront
const oai = new aws.cloudfront.OriginAccessIdentity("oai");

// Configure CloudFront distribution
const cdn = new aws.cloudfront.Distribution("cdn", {
    enabled: true,
    origins: [{
        domainName: bucket.bucketRegionalDomainName,
        originId: bucket.id,
        s3OriginConfig: { originAccessIdentity: oai.cloudfrontAccessIdentityPath },
    }],
    aliases: [
        mydomainName,
    ],    
    defaultCacheBehavior: {
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        targetOriginId: bucket.id,
        forwardedValues: { queryString: false, cookies: { forward: "none" } },
    },
    viewerCertificate: {
        acmCertificateArn: certificate.arn,
        sslSupportMethod: "sni-only",
    },
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    defaultRootObject: "index.html",

});

// Create a DNS A record to point to the CDN.
const record = new aws.route53.Record(mydomainName, {
    name: mydomainName,
    zoneId: zone.zoneId,
    type: "CNAME",
    aliases: [
        {
            name: cdn.domainName,
            zoneId: cdn.hostedZoneId,
            evaluateTargetHealth: true,
        }
    ],
}, { dependsOn: certificate });




// Export the name of the bucket
export const bucketEndpoint = pulumi.interpolate`http://${website.websiteEndpoint}`;
export const bucketName = bucket.id;
export const domainURL = `https://${mydomainName}`;
